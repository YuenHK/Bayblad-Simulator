#!/usr/bin/env bash
set -euo pipefail
die(){ echo "release bootstrap refused: $1" >&2;exit 1;}
[[ $(id -u) -eq 0 && $# -eq 5 ]]||die "root and artifact/authorization/pending/token/state required"
/opt/steam-top-bootstrap/verify-bootstrap.sh;artifact=$1;bundle=$2;pending=$3;token=$4;state_dir=$5;config=/etc/steam-top-bootstrap/trust.json
for file in "$bundle" "$pending" "$token";do [[ $file == /* && -f $file && ! -L $file ]]||die "unsafe input";done;[[ $artifact == /* && -d $artifact && ! -L $artifact ]]||die "artifact"
readarray -t trust < <(node - "$config" <<'NODE'
const x=require(process.argv[2]);for(const k of ["repository","workflowIdentity","workflowRef","workflowSha"])if(typeof x[k]!=="string")process.exit(1);const purpose=x.deploymentPurpose??"production";if(!["production","release-integration"].includes(purpose))process.exit(1);console.log(x.repository);console.log(x.workflowIdentity);console.log(x.workflowRef);console.log(x.workflowSha);console.log(purpose);
NODE
);repository=${trust[0]};workflow_identity=${trust[1]};workflow_ref=${trust[2]};workflow_sha=${trust[3]};deployment_purpose=${trust[4]}
GH_TOKEN=$(<"$token");export GH_TOKEN;snapshot=$(mktemp -d);trap 'rm -rf "$snapshot"' EXIT
cp "$bundle" "$snapshot/deployment-authorization.json";cp "$pending" "$snapshot/pending.json";for name in release-manifest.json runtime-files.sha256 APPROVED-RELEASE.json ROLLBACK-SOURCES.json;do [[ ! -f $artifact/$name ]]||cp "$artifact/$name" "$snapshot/$name";done;chmod 400 "$snapshot"/*
gh attestation verify "$snapshot/deployment-authorization.json" --repo "$repository" --signer-workflow "$workflow_identity" --format json >"$snapshot/authorization-attestation.json"||die "protected authorization attestation"
node /opt/steam-top-bootstrap/verify-attestation-identity.mjs "$snapshot/authorization-attestation.json" "$config" "$snapshot/deployment-authorization.json"||die "protected workflow ref/digest"
values=$(node - "$snapshot/deployment-authorization.json" "$snapshot/pending.json" "$snapshot/release-manifest.json" "$snapshot/runtime-files.sha256" "${snapshot}/APPROVED-RELEASE.json" "$repository" "$deployment_purpose" <<'NODE'
const fs=require("fs"),crypto=require("crypto"),a=require(process.argv[2]),p=require(process.argv[3]),m=require(process.argv[4]),runtime=fs.readFileSync(process.argv[5]),approvedPath=process.argv[6],repo=process.argv[7],purpose=process.argv[8],digest=x=>crypto.createHash("sha256").update(x).digest("hex"),approved=fs.existsSync(approvedPath)?require(approvedPath):null;if(a.schemaVersion!==1||a.purpose!==`${purpose}-deployment-authorization`||a.deploymentPurpose!==purpose||a.repository!==repo||p.payload?.purpose!==purpose||a.commit!==m.commit||a.commit!==p.ref||a.manifestSha256!==digest(fs.readFileSync(process.argv[4]))||a.runtimeManifestSha256!==digest(runtime)||a.pendingSha256!==digest(fs.readFileSync(process.argv[3]))||a.deploymentId!==String(p.payload.deploymentId??a.deploymentId)||a.nonce!==p.payload.nonce||a.expectedPreviousState!==p.payload.expectedPreviousState)process.exit(1);if(a.signerKind==="normal"&&(!approved||approved.purpose!=="approved-release"||approved.commit!==a.commit||approved.manifestSha256!==a.manifestSha256||a.approvedMarkerSha256!==digest(fs.readFileSync(approvedPath))))process.exit(1);console.log([a.runtimeManifestSha256,a.commit,a.signerWorkflow].join("|"));
NODE
)||die "authorization binding";IFS='|' read -r runtime_sha commit signer_workflow <<EOF
$values
EOF
gh attestation verify "$snapshot/runtime-files.sha256" --repo "$repository" --signer-workflow "$signer_workflow" >/dev/null||die "runtime attestation";gh attestation verify "$snapshot/release-manifest.json" --repo "$repository" --signer-workflow "$signer_workflow" >/dev/null||die "release attestation";if [[ -f $snapshot/APPROVED-RELEASE.json ]];then gh attestation verify "$snapshot/APPROVED-RELEASE.json" --repo "$repository" --signer-workflow "$signer_workflow" >/dev/null||die "APPROVED-RELEASE.json attestation";fi
release_root="/opt/steam-top/releases/$runtime_sha";if [[ ! -e $release_root ]];then
  install -d -o root -g root -m 0555 /opt/steam-top /opt/steam-top/releases;tmp_release=$(mktemp -d "/opt/steam-top/releases/.${runtime_sha}.XXXXXX")
  while IFS=' ' read -r digest mode path extra;do [[ -z ${extra:-} && $path =~ ^[A-Za-z0-9._/-]+$ && $path != *..* ]]||die "runtime manifest";source="$artifact/runtime/$path";[[ -f $source && ! -L $source ]]||die "runtime file missing";actual=$(sha256sum "$source"|awk '{print $1}');[[ $actual == "$digest" ]]||die "runtime file digest";install -D -o root -g root -m "$mode" "$source" "$tmp_release/$path";done <"$snapshot/runtime-files.sha256"
  install -o root -g root -m 0444 "$snapshot/runtime-files.sha256" "$tmp_release/runtime-files.sha256";node - "$runtime_sha" "$commit" "$tmp_release/runtime-install-receipt.json" <<'NODE'
const fs=require("fs");fs.writeFileSync(process.argv[4],JSON.stringify({schemaVersion:1,purpose:"steam-top-runtime-install",installRoot:process.argv[4].replace(/\/runtime-install-receipt\.json$/,""),runtimeManifestSha256:process.argv[2],commit:process.argv[3],sealedAt:new Date().toISOString()})+"\n",{mode:0o444});
NODE
  chmod 0444 "$tmp_release/runtime-install-receipt.json";mv "$tmp_release" "$release_root"
fi
ln -sfn "$release_root" /opt/steam-top/current.next;mv -Tf /opt/steam-top/current.next /opt/steam-top/current
  RUNTIME_INSTALL_MANIFEST_SHA256=$runtime_sha DEPLOYMENT_AUTHORIZATION_PURPOSE=$deployment_purpose "$release_root/scripts/prepare-deployment-authorization.sh" "$artifact" "$pending" "$repository" "$(node -p 'require(process.argv[1]).deploymentId' "$bundle")" "$token" "$state_dir"
