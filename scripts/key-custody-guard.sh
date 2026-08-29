#!/usr/bin/env bash
key_trusted_parents(){ local path=$1 directory owner mode;directory=$(dirname "$path");while [[ $directory != / ]];do [[ -d $directory && ! -L $directory ]]||return 1;read -r owner mode < <(stat -c '%u %a' "$directory");[[ $owner == 0 && $((8#$mode&022)) -eq 0 ]]||return 1;directory=$(dirname "$directory");done;}
key_private_file(){ local path=$1 owner mode;[[ $path == /* && -f $path && ! -L $path ]]||return 1;read -r owner mode < <(stat -c '%u %a' "$path");[[ $owner == 0 && $mode == 400 ]]||return 1;key_trusted_parents "$path";}
key_allowed_signers_file(){ local path=$1 owner mode;[[ $path == /* && -f $path && ! -L $path ]]||return 1;read -r owner mode < <(stat -c '%u %a' "$path");[[ $owner == 0 && $mode == 444 ]]||return 1;key_trusted_parents "$path";}
