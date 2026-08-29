#!/usr/bin/env bash
set -euo pipefail
die(){ echo "deployment authorization refused: $1" >&2;exit 1;}
[[ $(id -u) -eq 0 && $# -eq 6 ]]||die "root and artifact/pending/repository/deployment/token/state required"
artifact=$1;pending=$2;repository=$3;deployment_id=$4;token_file=$5;state_dir=$6
purpose=${DEPLOYMENT_AUTHORIZATION_PURPOSE:-};case $purpose in production) expected_environment=production;;release-integration) expected_environment=release-host-integration;;*) die "authorization purpose";;esac
script_path=$(realpath "$0");script_dir=$(CDPATH= cd -- "$(dirname -- "$script_path")"&&pwd -P);root=$(CDPATH= cd -- "$script_dir/.."&&pwd -P);source "$root/infra/backup/host-trust-guard.sh"
[[ $script_path == /opt/steam-top/scripts/prepare-deployment-authorization.sh ]]||die "installed canonical path required"
backup_trusted_root_deployment "$root" "$script_dir" "$root/infra/backup"||die "installed deployment trust"
backup_private_file "$token_file"||die "token trust"
[[ $artifact == /* && -d $artifact && ! -L $artifact && $pending == /* && -f $pending && ! -L $pending ]]||die "unsafe inputs"
[[ -d $state_dir && ! -L $state_dir ]]||die "state directory";read -r owner mode < <(stat -c '%u %a' "$state_dir");[[ $owner == 0 && $mode == 700 ]]||die "state directory trust"
snapshot=$(mktemp -d);chmod 700 "$snapshot";trap 'rm -rf "$snapshot"' EXIT;cp "$pending" "$snapshot/pending.json";cp "$artifact/release-manifest.json" "$snapshot/release-manifest.json";chmod 400 "$snapshot"/*
values=$(node - "$snapshot/pending.json" "$snapshot/release-manifest.json" "$repository" <<'NODE'
const fs=require("fs"),crypto=require("crypto"),request=JSON.parse(fs.readFileSync(process.argv[2])),manifestBytes=fs.readFileSync(process.argv[3]),manifest=JSON.parse(manifestBytes),repo=process.argv[4],p=request.payload,environment={production:"production","release-integration":"release-host-integration"}[process.env.DEPLOYMENT_AUTHORIZATION_PURPOSE];
if(request.environment!==environment||p?.schemaVersion!==4||p.purpose!==process.env.DEPLOYMENT_AUTHORIZATION_PURPOSE||request.ref!==p.commit||manifest.commit!==p.commit||JSON.stringify(manifest.images)!==JSON.stringify(p.images)||!/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.test(repo))process.exit(1);
const digest=crypto.createHash("sha256").update(manifestBytes).digest("hex");if(digest!==p.manifestSha256||!/^[a-f0-9]{64}$/.test(p.nonce)||!/^(none|[1-9][0-9]*\|[a-f0-9]{64})$/.test(p.expectedPreviousState))process.exit(1);
process.stdout.write([p.nonce,p.manifestSha256,p.commit,p.expectedPreviousState,p.signerKind,p.sourceWorkflow,p.runId,p.artifact,p.sourceHeadSha,p.sourceRef,p.sourceEvent].join("|"));
NODE
)||die "authorization bundle schema"
IFS='|' read -r nonce manifest_sha commit expected_state signer_kind signer_workflow run_id artifact_name source_head source_ref source_event <<EOF
$values
EOF
case $signer_kind in normal) [[ $signer_workflow == "$repository/.github/workflows/ci.yml" ]]||die signer;;rollback) [[ $signer_workflow == "$repository/.github/workflows/authorize-rollback.yml" ]]||die signer;;*) die signer;;esac
GH_TOKEN=$(<"$token_file");export GH_TOKEN
gh attestation verify "$snapshot/release-manifest.json" --repo "$repository" --signer-workflow "$signer_workflow" >/dev/null||die "attestation"
gh api "repos/$repository/actions/runs/$run_id" >"$snapshot/run.json";gh api "repos/$repository/actions/runs/$run_id/artifacts" >"$snapshot/artifacts.json"
node - "$snapshot/run.json" "$snapshot/artifacts.json" "$source_head" "$source_ref" "$source_event" "$artifact_name" "$signer_kind" <<'NODE'
const fs=require("fs"),run=JSON.parse(fs.readFileSync(process.argv[2])),artifacts=JSON.parse(fs.readFileSync(process.argv[3])).artifacts??[],path={normal:".github/workflows/ci.yml",rollback:".github/workflows/authorize-rollback.yml"}[process.argv[8]];if(run.path!==path||run.head_sha!==process.argv[4]||run.head_branch!==process.argv[5].replace(/^refs\/(?:heads|tags)\//,"")||run.event!==process.argv[6]||!["in_progress","completed"].includes(run.status)||artifacts.filter(x=>x.name===process.argv[7]&&!x.expired).length!==1)process.exit(1);
NODE
[[ $deployment_id =~ ^[1-9][0-9]*$ ]]||die "deployment id"
bound=$(gh api "repos/$repository/deployments/$deployment_id" --jq '[.payload.nonce,.payload.expectedPreviousState,.payload.manifestSha256,.sha,.environment]|join("|")');[[ $bound == "$nonce|$expected_state|$manifest_sha|$commit|$expected_environment" ]]||die "deployment state advanced"
output="$state_dir/$nonce.json";[[ ! -e $output && ! -e $output.consumed ]]||die "nonce used";tmp=$(mktemp "$state_dir/.authorization.XXXXXX");trap 'rm -rf "$snapshot";rm -f "$tmp"' EXIT
node - "$snapshot/pending.json" "$repository" "$deployment_id" "$purpose" "$tmp" <<'NODE'
const fs=require("fs"),r=JSON.parse(fs.readFileSync(process.argv[2])),p=r.payload;fs.writeFileSync(process.argv[6],JSON.stringify({schemaVersion:2,state:"pending",purpose:process.argv[5],repository:process.argv[3],deploymentId:process.argv[4],nonce:p.nonce,manifestSha256:p.manifestSha256,commit:p.commit,expectedPreviousState:p.expectedPreviousState,signerKind:p.signerKind,sourceWorkflow:p.sourceWorkflow,authorizedAt:new Date().toISOString()})+"\n",{mode:0o400});
NODE
chmod 400 "$tmp";mv "$tmp" "$output";rm -rf "$snapshot";trap - EXIT
