#!/usr/bin/env bash
set -euo pipefail
die(){ echo "bootstrap installation refused: $1" >&2;exit 1;}
[[ $(id -u) -eq 0 && ( $# -eq 4 || ( $# -eq 5 && $5 =~ ^--(install-systemd|no-systemd-for-integration)$ ) || ( $# -eq 7 && $5 == --install-systemd && $6 == --initialize-first-deploy && $7 =~ ^[a-f0-9]{64}$ ) ) ]]||die "root and archive/signature/signer/config [systemd policy] [--initialize-first-deploy nonce] required"
archive=$1;signature=$2;signer=$3;config=$4;systemd_policy=${5:-};first_deploy_nonce=;[[ $# -eq 7 ]]&&first_deploy_nonce=$7;: "${EXPECTED_BOOTSTRAP_ARCHIVE_SHA256:?}" "${BOOTSTRAP_ALLOWED_SIGNERS_FILE:?}"
[[ $EXPECTED_BOOTSTRAP_ARCHIVE_SHA256 =~ ^[a-f0-9]{64}$ && -f $archive && ! -L $archive && -f $signature && ! -L $signature && -f $config && ! -L $config ]]||die "inputs"
deployment_purpose=$(node -p 'const x=require(process.argv[1]).deploymentPurpose??"production";if(!["production","release-integration"].includes(x))process.exit(1);x' "$config")||die "deployment purpose";if [[ $deployment_purpose == production ]];then [[ -z $systemd_policy || $systemd_policy == --install-systemd ]]||die "production requires systemd";systemd_policy=--install-systemd;else [[ $systemd_policy == --no-systemd-for-integration ]]||die "integration must explicitly waive systemd";fi
bootstrap_preexisting=false;[[ -e /opt/steam-top-bootstrap/bootstrap-files.sha256 || -d /var/lib/steam-top-bootstrap/install-transaction || -d /var/lib/steam-top-bootstrap/install-receipts || -L /var/lib/steam-top-bootstrap/first-deploy/current || -e /opt/steam-top/current ]]&&bootstrap_preexisting=true
[[ $deployment_purpose != production || $bootstrap_preexisting == true || -n $first_deploy_nonce ]]||die "clean production install requires explicit first-deploy initialization"
trusted_parents(){ local directory owner mode;directory=$(dirname "$1");while [[ $directory != / ]];do [[ -d $directory && ! -L $directory ]]||return 1;read -r owner mode < <(stat -c '%u %a' "$directory");[[ $owner == 0 && $((8#$mode&022)) -eq 0 ]]||return 1;directory=$(dirname "$directory");done;};read -r ao am < <(stat -c '%u %a' "$BOOTSTRAP_ALLOWED_SIGNERS_FILE");read -r co cm < <(stat -c '%u %a' "$config");[[ $ao == 0 && $am == 444 && $co == 0 && $cm == 400 ]]&&trusted_parents "$BOOTSTRAP_ALLOWED_SIGNERS_FILE"&&trusted_parents "$config"||die "root external trust inputs"
sha(){ if command -v sha256sum >/dev/null;then sha256sum "$1"|awk '{print $1}';else shasum -a 256 "$1"|awk '{print $1}';fi;}
tmp=$(mktemp -d);chmod 0700 "$tmp";trap 'rm -rf "$tmp"' EXIT
# Copy each untrusted runner path exactly once through a no-follow fd.  Every
# later verifier consumes only these root-private bootstrap-input-snapshot files.
python3 - "$archive" "$signature" "$tmp" <<'PY'||die "bootstrap input snapshot"
import os,stat,sys
sources=sys.argv[1:3];target=sys.argv[3]
for source,name,minimum,maximum in zip(sources,("archive.tgz","archive.tgz.sig"),(1,1),(8_388_608,65_536)):
 fd=os.open(source,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  initial=os.fstat(fd);size=initial.st_size
  if not stat.S_ISREG(initial.st_mode) or size<minimum or size>maximum:raise SystemExit(1)
  out=os.open(os.path.join(target,name),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o444)
  try:
   copied=0
   while copied<size:
    chunk=os.read(fd,min(65536,size-copied))
    if not chunk:break
    written=0
    while written<len(chunk):
     count=os.write(out,chunk[written:])
     if count<=0:raise SystemExit(1)
     written+=count
    copied+=len(chunk)
   if copied!=size or os.read(fd,1) or os.fstat(fd).st_size!=size:raise SystemExit("snapshot source changed")
   os.fchmod(out,0o444);os.fsync(out)
  finally:os.close(out)
 finally:os.close(fd)
directory=os.open(target,os.O_RDONLY|os.O_DIRECTORY);os.fsync(directory);os.close(directory)
PY
archive="$tmp/archive.tgz";signature="$tmp/archive.tgz.sig"
[[ $(sha "$archive") == "$EXPECTED_BOOTSTRAP_ARCHIVE_SHA256" ]]||die "external archive digest"
archive_size=$(stat -c %s "$archive");[[ $archive_size =~ ^[0-9]+$ && $archive_size -ge 1 && $archive_size -le 8388608 ]]||die "compressed archive size"
ssh-keygen -Y verify -q -f "$BOOTSTRAP_ALLOWED_SIGNERS_FILE" -I "$signer" -n steam-top-bootstrap-source -s "$signature" <"$archive"||die "external archive signature"
validator=${BOOTSTRAP_TAR_VALIDATOR:?};validator_sha=${BOOTSTRAP_TAR_VALIDATOR_SHA256:?};[[ $validator == /* && -f $validator && ! -L $validator && $validator_sha =~ ^[a-f0-9]{64}$ && $(stat -c '%u %a' "$validator") == '0 444' && $(sha "$validator") == "$validator_sha" ]]&&trusted_parents "$validator"||die "pretrusted tar validator"
validator_result=$(python3 "$validator" "$archive" "$tmp/.validated.tar")||die "unsafe or invalid signed archive";[[ $validator_result =~ ^OK\ [1-9][0-9]*$ && -f $tmp/.validated.tar && ! -L $tmp/.validated.tar && $(stat -c '%a' "$tmp/.validated.tar") == 400 ]]||die "tar validator token"
python3 - "$archive" "$tmp" "$0" <<'PY'||die "unsafe or invalid signed archive"
import hashlib,os,re,sys,tarfile
archive_path,target,installer=sys.argv[1:]
raw_path=os.path.join(target,".validated.tar")
with tarfile.open(raw_path,"r:") as tar:
  if tar.pax_headers: raise SystemExit("global pax metadata")
  by_name={};total=0
  # Iterate directly: metadata allocation, member count and
  # expanded bytes are bounded while the gzip stream is consumed.
  for member in tar:
    if len(by_name)>=64 or member.pax_headers or member.type!=tarfile.REGTYPE or member.sparse is not None or member.linkname or member.name in by_name or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*",member.name) or member.uid!=0 or member.gid!=0 or member.size<0 or member.size>2_097_152: raise SystemExit("archive header")
    total+=member.size
    if total>16_777_216: raise SystemExit("archive expansion")
    by_name[member.name]=member
  if not by_name: raise SystemExit("archive count")
  manifest_member=by_name.get("bootstrap-files.sha256")
  if not manifest_member or manifest_member.mode!=0o644 or manifest_member.size>65_536: raise SystemExit("manifest header")
  manifest=tar.extractfile(manifest_member).read().decode("ascii")
  expected={}
  for line in manifest.splitlines():
    match=re.fullmatch(r"([a-f0-9]{64}) (0444|0555) ([A-Za-z0-9][A-Za-z0-9._-]*)",line)
    if not match or match.group(3) in expected: raise SystemExit("manifest grammar")
    expected[match.group(3)]=(match.group(1),int(match.group(2),8))
  if set(by_name)!=(set(expected)|{"bootstrap-files.sha256"}) or "install-bootstrap.sh" not in expected: raise SystemExit("archive membership")
  for name,(digest,mode) in expected.items():
    member=by_name[name]
    if member.mode!=mode: raise SystemExit("archive mode")
    data=tar.extractfile(member).read()
    if hashlib.sha256(data).hexdigest()!=digest: raise SystemExit("archive digest")
    path=os.path.join(target,name)
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
    with os.fdopen(fd,"wb") as output: output.write(data);output.flush();os.fsync(output.fileno())
  manifest_path=os.path.join(target,"bootstrap-files.sha256")
  fd=os.open(manifest_path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
  with os.fdopen(fd,"wb") as output: output.write(manifest.encode("ascii"));output.flush();os.fsync(output.fileno())
with open(installer,"rb") as running:
  if hashlib.sha256(running.read()).hexdigest()!=expected["install-bootstrap.sh"][0]: raise SystemExit("installer digest")
os.unlink(raw_path)
PY
node "$tmp/verify-package-tree.mjs" "$tmp" "$0"||die "signed package tree"
if [[ $deployment_purpose == production ]];then mapfile -t preflight_signing < <(node - "$config" <<'NODE'
const c=require(process.argv[2]);for(const k of ["productionStateSigningKey","productionStateAllowedSigners","productionStateSignerId","cutoverPgService","cutoverPgServiceFile","cutoverPgPassFile","cutoverIncidentDir"]){if(typeof c[k]!=="string"||!c[k])process.exit(1);console.log(c[k])}
NODE
);[[ ${#preflight_signing[@]} -eq 7 && -f ${preflight_signing[0]} && ! -L ${preflight_signing[0]} && $(stat -c '%u %a' "${preflight_signing[0]}") == '0 400' && -f ${preflight_signing[1]} && ! -L ${preflight_signing[1]} && $(stat -c '%u %a' "${preflight_signing[1]}") == '0 444' && -f ${preflight_signing[4]} && ! -L ${preflight_signing[4]} && $(stat -c '%u %a' "${preflight_signing[4]}") == '0 400' && -f ${preflight_signing[5]} && ! -L ${preflight_signing[5]} && $(stat -c '%u %a' "${preflight_signing[5]}") == '0 400' && -d ${preflight_signing[6]} && ! -L ${preflight_signing[6]} && $(stat -c '%u %a' "${preflight_signing[6]}") == '0 700' ]]||die "signing/PG/incident preflight";trusted_parents "${preflight_signing[0]}"&&trusted_parents "${preflight_signing[1]}"&&trusted_parents "${preflight_signing[4]}"&&trusted_parents "${preflight_signing[5]}"&&trusted_parents "${preflight_signing[6]}"||die "production input parents";public=$(ssh-keygen -y -f "${preflight_signing[0]}");[[ $(awk -v id="${preflight_signing[2]}" -v key="$public" '$1==id{$1="";sub(/^ /,"");if($0==key)n++}END{print n+0}' "${preflight_signing[1]}") == 1 ]]||die "signer mapping preflight";[[ $(sha "$0") == $(sha "$tmp/install-bootstrap.sh") ]]||die "installer is not the signed canonical installer";[[ $(uname -s) == Linux && -d /run/systemd/system ]]||die "systemd Linux host required";fi
install_resume=false
if [[ $deployment_purpose == production && -n $first_deploy_nonce ]];then
  host_raw=$(cat /etc/machine-id 2>/dev/null||hostname);host_file=$(mktemp);printf %s "$host_raw" >"$host_file";host_preflight=$(sha "$host_file");rm -f "$host_file";journal_dir=/var/lib/steam-top-bootstrap/install-transaction;journal=$journal_dir/payload.json;config_digest=$(sha "$config");allowed_digest=$(sha "$BOOTSTRAP_ALLOWED_SIGNERS_FILE");installer_digest=$(sha "$0")
  if [[ -e $journal_dir ]];then [[ -d $journal_dir && ! -L $journal_dir && $(stat -c '%u %a' "$journal_dir") == '0 500' && -f $journal && ! -L $journal && -f $journal.sig && ! -L $journal.sig && $(stat -c '%u %a' "$journal") == '0 400' && $(stat -c '%u %a' "$journal.sig") == '0 400' ]]||die "install journal trust";ssh-keygen -Y verify -q -f "${preflight_signing[1]}" -I "${preflight_signing[2]}" -n steam-top-bootstrap-install-journal -s "$journal.sig" <"$journal"||die "install journal signature";node -e 'const x=require(process.argv[1]);if(x.schemaVersion!==1||x.purpose!=="steam-top-bootstrap-install-journal"||x.initNonce!==process.argv[2]||x.archiveDigest!==process.argv[3]||x.hostId!==process.argv[4]||x.trustConfigDigest!==process.argv[5]||x.sourceAllowedSignersDigest!==process.argv[6]||x.sourceSignerId!==process.argv[7]||x.installerDigest!==process.argv[8]||x.systemdPolicy!==process.argv[9])process.exit(1)' "$journal" "$first_deploy_nonce" "$EXPECTED_BOOTSTRAP_ARCHIVE_SHA256" "$host_preflight" "$config_digest" "$allowed_digest" "$signer" "$installer_digest" "$systemd_policy"||die "install journal binding";install_resume=true
  else [[ $bootstrap_preexisting == false ]]||die "preexisting host has no valid install journal";install -d -o root -g root -m 0700 /var/lib/steam-top-bootstrap;journal_stage=$(mktemp -d /var/lib/steam-top-bootstrap/.install-transaction.XXXXXX);node - "$journal_stage/payload.json" "$first_deploy_nonce" "$EXPECTED_BOOTSTRAP_ARCHIVE_SHA256" "$host_preflight" "${preflight_signing[2]}" "$config_digest" "$allowed_digest" "$signer" "$installer_digest" "$systemd_policy" <<'NODE'
const fs=require("fs"),[out,initNonce,archiveDigest,hostId,signerKeyId,trustConfigDigest,sourceAllowedSignersDigest,sourceSignerId,installerDigest,systemdPolicy]=process.argv.slice(2);fs.writeFileSync(out,JSON.stringify({schemaVersion:1,purpose:"steam-top-bootstrap-install-journal",initNonce,archiveDigest,hostId,signerKeyId,trustConfigDigest,sourceAllowedSignersDigest,sourceSignerId,installerDigest,systemdPolicy,createdAt:new Date().toISOString()})+"\n",{mode:0o400})
NODE
    ssh-keygen -Y sign -q -f "${preflight_signing[0]}" -n steam-top-bootstrap-install-journal "$journal_stage/payload.json";chmod 0400 "$journal_stage/payload.json.sig";chown root:root "$journal_stage/payload.json" "$journal_stage/payload.json.sig";chmod 0500 "$journal_stage";sync -f "$journal_stage";mv "$journal_stage" "$journal_dir";sync -f /var/lib/steam-top-bootstrap
  fi
fi
install -d -o root -g root -m 0555 /opt;tree_stage=$(mktemp -d /opt/.steam-top-bootstrap.stage.XXXXXX);trap 'rm -rf "$tmp" "${tree_stage:-}"' EXIT
while IFS=' ' read -r digest mode path extra;do [[ -z ${extra:-} && $path =~ ^[A-Za-z0-9._/-]+$ && $path != *..* ]]||die "manifest grammar";[[ -f $tmp/$path && ! -L $tmp/$path && $(sha "$tmp/$path") == "$digest" ]]||die "package digest";install -D -o root -g root -m "$mode" "$tmp/$path" "$tree_stage/$path";done <"$tmp/bootstrap-files.sha256"
install -o root -g root -m 0400 "$tmp/bootstrap-files.sha256" "$tree_stage/bootstrap-files.sha256";find "$tree_stage" -type d -exec chmod 0555 {} +;sync -f "$tree_stage"
if [[ -e /opt/steam-top-bootstrap ]];then diff -qr --no-dereference "$tree_stage" /opt/steam-top-bootstrap >/dev/null||die "installed bootstrap differs; use explicit audited upgrade";rm -rf "$tree_stage";tree_stage=;else mv "$tree_stage" /opt/steam-top-bootstrap;tree_stage=;sync -f /opt;fi
if [[ $deployment_purpose == production ]];then systemd-analyze verify /opt/steam-top-bootstrap/steam-top-cutover-reaper.service /opt/steam-top-bootstrap/steam-top-cutover-reaper.timer||die "systemd units invalid";fi
ceremony_root=/opt/steam-top-policy-ceremony;install -d -o root -g root -m 0555 "$ceremony_root";scavenge_ceremony_stages(){ local stale child mode owner;shopt -s nullglob;for stale in "$ceremony_root"/.stage.??????;do [[ -d $stale && ! -L $stale && $(basename "$stale") =~ ^\.stage\.[A-Za-z0-9]{6}$ ]]||die "unsafe ceremony stage";read -r owner mode < <(stat -c '%u %a' "$stale");[[ $owner == 0 && ( $mode == 700 || $mode == 555 ) ]]||die "unsafe ceremony stage custody";for child in "$stale"/*;do [[ -e $child ]]||continue;[[ -f $child && ! -L $child && $(basename "$child") =~ ^(verify-and-create-production-policy-entry\.sh|verify-production-policy-anchor\.mjs|create-production-policy-ledger-entry\.mjs|verify-attestation-identity\.mjs)$ && $(stat -c %u "$child") == 0 ]]||die "unsafe ceremony stage content";done;rm -rf -- "$stale";done;shopt -u nullglob;};scavenge_ceremony_stages
ceremony_files="$tmp/policy-ceremony-files.json";node - "$ceremony_files" "$(sha /opt/steam-top-bootstrap/verify-and-create-production-policy-entry.sh)" "$(sha /opt/steam-top-bootstrap/verify-production-policy-anchor.mjs)" "$(sha /opt/steam-top-bootstrap/create-production-policy-ledger-entry.mjs)" "$(sha /opt/steam-top-bootstrap/verify-attestation-identity.mjs)" <<'NODE'
const fs=require("fs"),[out,verify,anchor,create,attestation]=process.argv.slice(2);fs.writeFileSync(out,JSON.stringify({files:{"verify-and-create-production-policy-entry.sh":verify,"verify-production-policy-anchor.mjs":anchor,"create-production-policy-ledger-entry.mjs":create,"verify-attestation-identity.mjs":attestation}})+"\n")
NODE
ceremony_id=$(sha "$ceremony_files");ceremony_path=$ceremony_root/$ceremony_id;ceremony_stage=$(mktemp -d "$ceremony_root/.stage.XXXXXX");trap 'rm -rf "$tmp" "${tree_stage:-}" "${ceremony_stage:-}"' EXIT;for name in verify-and-create-production-policy-entry.sh verify-production-policy-anchor.mjs create-production-policy-ledger-entry.mjs verify-attestation-identity.mjs;do mode=0444;[[ $name == *.sh ]]&&mode=0555;install -o root -g root -m "$mode" "/opt/steam-top-bootstrap/$name" "$ceremony_stage/$name";done;chmod 0555 "$ceremony_stage";sync -f "$ceremony_stage"
if [[ -e $ceremony_path ]];then diff -qr --no-dereference "$ceremony_stage" "$ceremony_path" >/dev/null||die "ceremony generation collision";rm -rf "$ceremony_stage";else mv "$ceremony_stage" "$ceremony_path";sync -f "$ceremony_root";fi
publish_exact(){ local source=$1 target=$2 mode=$3 parent tmp_file;if [[ -e $target ]];then [[ -f $target && ! -L $target && $(stat -c '%u %a' "$target") == "0 $mode" && $(sha "$target") == $(sha "$source") ]]||die "existing output differs: $target";return;fi;parent=$(dirname "$target");tmp_file=$(mktemp "$parent/.install-output.XXXXXX");install -o root -g root -m "$mode" "$source" "$tmp_file";sync -f "$tmp_file";mv "$tmp_file" "$target";sync -f "$parent";}
install -d -o root -g root -m 0555 /etc/steam-top-bootstrap;publish_exact "$config" /etc/steam-top-bootstrap/trust.json 400
ceremony_manifest="$tmp/policy-ceremony-manifest.json";node - "$ceremony_manifest" "$ceremony_id" "$ceremony_path" "$ceremony_files" <<'NODE'
const fs=require("fs"),[out,generationDigest,generationPath,filesPath]=process.argv.slice(2),files=require(filesPath).files;fs.writeFileSync(out,JSON.stringify({schemaVersion:1,purpose:"steam-top-production-policy-ceremony",generationDigest,generationPath,files})+"\n",{mode:0o400})
NODE
publish_exact "$ceremony_manifest" /etc/steam-top-bootstrap/policy-ceremony-manifest.json 400
python_runtime=$(readlink -f /usr/bin/python3);[[ $python_runtime == /* && -f $python_runtime && ! -L $python_runtime ]]||die "policy signer Python runtime"
signer_manifest="$tmp/policy-signer-manifest.json";python3 - "$signer_manifest" "$python_runtime" /opt/steam-top-bootstrap/sign-production-policy-entry.py <<'PY'||die "policy signer manifest"
import hashlib,json,os,stat,sys
out,runtime,signer=sys.argv[1:]
def sha(path):
 h=hashlib.sha256()
 with open(path,"rb") as source:
  for block in iter(lambda:source.read(65536),b""):h.update(block)
 return h.hexdigest()
s=os.stat(runtime,follow_symlinks=False)
if s.st_uid!=0 or s.st_nlink!=1 or s.st_mode&0o022 or not stat.S_ISREG(s.st_mode):raise SystemExit(1)
value={"schemaVersion":1,"purpose":"steam-top-production-policy-signer","signerPath":signer,"signerSha256":sha(signer),"pythonPath":runtime,"pythonSha256":sha(runtime),"pythonStat":{"dev":str(s.st_dev),"ino":str(s.st_ino),"size":str(s.st_size),"mtimeNs":str(s.st_mtime_ns),"ctimeNs":str(s.st_ctime_ns),"uid":s.st_uid,"mode":stat.S_IMODE(s.st_mode),"nlink":s.st_nlink}}
with open(out,"x") as target:target.write(json.dumps(value,separators=(",",":"))+"\n");target.flush();os.fsync(target.fileno())
PY
publish_exact "$signer_manifest" /etc/steam-top-bootstrap/policy-signer-manifest.json 400
install -d -o root -g root -m 0700 /var/lib/steam-top-bootstrap
[[ -e /var/lock/steam-top-production.lock ]]||install -o root -g root -m 0600 /dev/null /var/lock/steam-top-production.lock
[[ -f /var/lock/steam-top-production.lock && ! -L /var/lock/steam-top-production.lock && $(stat -c '%u %a' /var/lock/steam-top-production.lock) == '0 600' ]]||die "production lock unsafe"
exec 9<>/var/lock/steam-top-production.lock;flock 9
if [[ $deployment_purpose == production && -z $first_deploy_nonce && $bootstrap_preexisting == true ]];then
  /opt/steam-top-bootstrap/read-install-receipt.sh >/dev/null||die "established host install receipt missing or corrupt"
  read -r established_phase _ < <(/opt/steam-top-bootstrap/read-first-deploy-state.sh)||die "established first-deploy chain missing or corrupt"
  [[ $established_phase == consumed ]]||die "established host is not in consumed phase"
fi
if [[ -n $first_deploy_nonce ]];then
  [[ $deployment_purpose == production && ( $bootstrap_preexisting == false || $install_resume == true ) ]]||die "first deploy may only use a matching transaction journal"
  source /opt/steam-top-bootstrap/key-custody-guard.sh
  mapfile -t marker_signing < <(node - "$config" <<'NODE'
const c=require(process.argv[2]);for(const k of ["productionStateSigningKey","productionStateAllowedSigners","productionStateSignerId"]){if(typeof c[k]!=="string"||!c[k])process.exit(1);console.log(c[k])}
NODE
  )
  [[ ${#marker_signing[@]} -eq 3 ]]&&key_signer_matches_allowed "${marker_signing[0]}" "${marker_signing[1]}" "${marker_signing[2]}"||die "first deploy signing identity"
  host_id=$(cat /etc/machine-id 2>/dev/null||hostname);host_id_file=$(mktemp);printf %s "$host_id" >"$host_id_file";host_id_sha=$(sha "$host_id_file");rm -f "$host_id_file"
  receipt_root=/var/lib/steam-top-bootstrap/install-receipts;if [[ ! -d $receipt_root ]];then install -d -o root -g root -m 0700 "$receipt_root";receipt_tmp=$(mktemp -d "$receipt_root/.stage.XXXXXX");bootstrap_digest=$(sha /opt/steam-top-bootstrap/bootstrap-files.sha256);installer_digest=$(sha "$0");node - "$receipt_tmp/payload.json" "$host_id_sha" "$bootstrap_digest" "$first_deploy_nonce" "$installer_digest" "${marker_signing[2]}" <<'NODE'
const fs=require("fs"),[out,hostId,bootstrapDigest,initNonce,installerDigest,signerKeyId]=process.argv.slice(2);fs.writeFileSync(out,JSON.stringify({schemaVersion:1,purpose:"steam-top-bootstrap-install-receipt",hostId,bootstrapDigest,initNonce,installerDigest,createdAt:new Date().toISOString(),signerKeyId})+"\n",{mode:0o400});
NODE
  ssh-keygen -Y sign -q -f "${marker_signing[0]}" -n steam-top-bootstrap-install "$receipt_tmp/payload.json";chmod 0400 "$receipt_tmp/payload.json.sig";receipt_id=$(sha "$receipt_tmp/payload.json");chmod 0500 "$receipt_tmp";sync -f "$receipt_tmp";mv "$receipt_tmp" "$receipt_root/$receipt_id";sync -f "$receipt_root";else /opt/steam-top-bootstrap/read-install-receipt.sh >/dev/null||die "existing install receipt invalid";fi
  /opt/steam-top-bootstrap/advance-first-deploy-state.sh pending "$first_deploy_nonce"
fi
flock -u 9;exec 9>&-
for lock in /var/lock/steam-top-generation-publish.lock /var/lock/steam-top-production.lock /var/lock/steam-top-release-integration.lock;do if [[ ! -e $lock ]];then install -o root -g root -m 0600 /dev/null "$lock";else [[ -f $lock && ! -L $lock ]]||die "lock unsafe";chmod 0600 "$lock";chown root:root "$lock";fi;done
/opt/steam-top-bootstrap/verify-bootstrap.sh
if [[ $systemd_policy == --install-systemd ]];then
  [[ $(uname -s) == Linux && -d /run/systemd/system ]]||die "systemd Linux host required"
  node - "$config" <<'NODE'||die "production reaper config"
const c=require(process.argv[2]);for(const k of ["cutoverPgService","cutoverPgServiceFile","cutoverPgPassFile","cutoverIncidentDir"]){if(typeof c[k]!=="string"||!c[k]||((k.endsWith("File")||k.endsWith("Dir"))&&!c[k].startsWith("/")))process.exit(1)}
NODE
  systemd-analyze verify /opt/steam-top-bootstrap/steam-top-cutover-reaper.service /opt/steam-top-bootstrap/steam-top-cutover-reaper.timer||die "systemd units invalid"
  publish_exact /opt/steam-top-bootstrap/steam-top-cutover-reaper.service /etc/systemd/system/steam-top-cutover-reaper.service 644
  publish_exact /opt/steam-top-bootstrap/steam-top-cutover-reaper.timer /etc/systemd/system/steam-top-cutover-reaper.timer 644
  systemd_failed=true;rollback_systemd(){ if [[ $systemd_failed == true ]];then systemctl disable --now steam-top-cutover-reaper.timer >/dev/null 2>&1||true;rm -f /etc/systemd/system/steam-top-cutover-reaper.service /etc/systemd/system/steam-top-cutover-reaper.timer;systemctl daemon-reload >/dev/null 2>&1||true;fi;};trap 'rollback_systemd;rm -rf "$tmp"' EXIT
  systemctl daemon-reload&&systemctl enable --now steam-top-cutover-reaper.timer&&timeout 30s systemctl start steam-top-cutover-reaper.service||die "cutover reaper activation"
  /opt/steam-top-bootstrap/verify-reaper-health.sh||die "cutover reaper health"
  systemd_failed=false
fi
