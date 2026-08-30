#!/usr/bin/python3
import datetime, hashlib, json, os, re, signal, stat, subprocess, sys, unicodedata

KEYS = ["schemaVersion","purpose","generation","previousReceiptDigest","repositoryId","repositoryName","policyCommit","policyTreeOid","bundleSha256","anchorSha256","anchorGeneration","createdAt","signerKeyId"]
HEX = lambda n: re.compile(rf"^[a-f0-9]{{{n}}}$")
child = None
parent_fd = None
output_name = None
output_created = False
stage_name = None
stage_created = False
CAUGHT = (signal.SIGHUP,signal.SIGINT,signal.SIGTERM)

def abort(message): raise ValueError(message)

def on_signal(number, _frame):
    global child
    if child is not None and child.poll() is None:
        child.terminate()
        try: child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            child.kill(); child.wait()
    raise InterruptedError(f"interrupted by signal {number}")

def open_parent(path):
    absolute = os.path.abspath(path); parts = absolute.split(os.sep); leaf = parts[-1]
    if not leaf or leaf in (".", ".."): abort("invalid path leaf")
    fd = os.open(os.sep, os.O_RDONLY | os.O_DIRECTORY); uid = os.getuid()
    try:
        for component in parts[1:-1]:
            if not component or component in (".", ".."): abort("invalid path component")
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            info = os.fstat(next_fd)
            if info.st_uid not in (0, uid) or info.st_mode & 0o022:
                os.close(next_fd); abort("unsafe parent custody")
            os.close(fd); fd = next_fd
        return fd, leaf
    except BaseException:
        os.close(fd); raise

def open_input(path, modes):
    directory, name = open_parent(path)
    try: fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    finally: os.close(directory)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) not in modes:
        os.close(fd); abort("input custody mismatch")
    return fd, info

def identity(info):
    return (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns,info.st_nlink,info.st_uid,info.st_mode)

def stable_read(fd, before):
    chunks = []
    while True:
        data = os.read(fd, 65536)
        if not data: break
        chunks.append(data)
    if identity(os.fstat(fd)) != identity(before): abort("input changed while reading")
    return b"".join(chunks)

def secure_key_reference(key_data):
    if not hasattr(os,"memfd_create") or not os.path.isdir("/proc/self/fd"):abort("Linux memfd signer required")
    fd=os.memfd_create("steam-top-policy-key",0);offset=0
    while offset<len(key_data):offset+=os.write(fd,key_data[offset:])
    os.lseek(fd,0,os.SEEK_SET);return fd,f"/proc/self/fd/{fd}"

def verify_output_binding(signature_fd,expected_info):
    bound_fd=os.open(output_name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent_fd)
    try:
        if identity(os.fstat(bound_fd))!=identity(expected_info) or identity(os.fstat(signature_fd))!=identity(expected_info):abort("verified signature output changed")
    finally:os.close(bound_fd)

def swap_output_for_test():
    if os.geteuid()==0 or os.environ.get("STEAM_TOP_POLICY_SIGNER_TEST_SWAP_OUTPUT_AFTER_VERIFY")!="1":return
    os.unlink(output_name,dir_fd=parent_fd);fd=os.open(output_name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o400,dir_fd=parent_fd)
    try:os.write(fd,b"foreign");os.fsync(fd)
    finally:os.close(fd)
    os.fsync(parent_fd)

def verify_signature(name,expected_info,entry,key_reference,key_handle,signer_id):
    signature_fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent_fd);allowed_fd=None
    try:
        if identity(os.fstat(signature_fd))!=identity(expected_info):abort("signature recovery changed")
        public=subprocess.run(["/usr/bin/ssh-keygen","-y","-f",key_reference],capture_output=True,pass_fds=(key_handle,),check=True).stdout.strip()
        allowed_fd=os.memfd_create("steam-top-policy-allowed",0);allowed=(signer_id.encode()+b" "+public+b"\n");offset=0
        while offset<len(allowed):offset+=os.write(allowed_fd,allowed[offset:])
        os.lseek(allowed_fd,0,os.SEEK_SET);os.set_inheritable(allowed_fd,True);os.set_inheritable(signature_fd,True)
        verified=subprocess.run(["/usr/bin/ssh-keygen","-Y","verify","-q","-f",f"/proc/self/fd/{allowed_fd}","-I",signer_id,"-n","steam-top-production-policy-root","-s",f"/proc/self/fd/{signature_fd}"],input=entry,capture_output=True,pass_fds=(allowed_fd,signature_fd))
        if verified.returncode:abort("existing signature does not bind current entry and key")
        swap_output_for_test();verify_output_binding(signature_fd,expected_info);return signature_fd
    except BaseException:
        os.close(signature_fd);raise
    finally:
        if allowed_fd is not None:os.close(allowed_fd)

def verify_recovery(stage,stage_info,entry,key_reference,key_handle,signer_id):
    try: output_info=os.stat(output_name,dir_fd=parent_fd,follow_symlinks=False)
    except FileNotFoundError: return False
    safe=lambda info:stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and stat.S_IMODE(info.st_mode)==0o400
    if not safe(stage_info) or not safe(output_info) or stage_info.st_nlink!=2 or output_info.st_nlink!=2 or (stage_info.st_dev,stage_info.st_ino)!=(output_info.st_dev,output_info.st_ino):abort("unsafe signature recovery links")
    signature_fd=verify_signature(stage,stage_info,entry,key_reference,key_handle,signer_id)
    try:
        os.fsync(parent_fd);verify_output_binding(signature_fd,stage_info);os.unlink(stage,dir_fd=parent_fd);os.fsync(parent_fd);return True
    finally:os.close(signature_fd)

def verify_output_only(entry,key_reference,key_handle,signer_id):
    try: info=os.stat(output_name,dir_fd=parent_fd,follow_symlinks=False)
    except FileNotFoundError:return False
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o400 or info.st_nlink!=1:abort("unsafe existing signature output")
    signature_fd=verify_signature(output_name,info,entry,key_reference,key_handle,signer_id)
    try:os.fsync(parent_fd);verify_output_binding(signature_fd,info);return True
    finally:os.close(signature_fd)

def scavenge_stages(entry,key_reference,key_handle,signer_id):
    prefix=f".steam-top-signature-stage-{hashlib.sha256(output_name.encode()).hexdigest()}-"
    recovered=False;matching=False
    for name in os.listdir(parent_fd):
        match=re.fullmatch(re.escape(prefix)+r"([1-9][0-9]*)-([a-f0-9]{16})",name)
        if not match:continue
        matching=True
        info=os.stat(name,dir_fd=parent_fd,follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_nlink not in (1,2) or stat.S_IMODE(info.st_mode)!=0o400:abort("unsafe signature stage")
        try:os.kill(int(match.group(1)),0);continue
        except ProcessLookupError:pass
        except PermissionError:continue
        try:os.stat(output_name,dir_fd=parent_fd,follow_symlinks=False);output_exists=True
        except FileNotFoundError:output_exists=False
        if info.st_nlink==2 or output_exists:
            if recovered or not verify_recovery(name,info,entry,key_reference,key_handle,signer_id):abort("incomplete signature recovery")
            recovered=True
        else:os.unlink(name,dir_fd=parent_fd);os.fsync(parent_fd)
    if not recovered and not matching:recovered=verify_output_only(entry,key_reference,key_handle,signer_id)
    return prefix,recovered

def validate(raw):
    try: text = raw.decode("utf-8"); value = json.loads(text)
    except (UnicodeDecodeError, json.JSONDecodeError) as error: raise ValueError("entry is not canonical JSON") from error
    if not isinstance(value, dict) or list(value.keys()) != KEYS: abort("entry keys or order invalid")
    integer = lambda item: isinstance(item, int) and not isinstance(item, bool)
    valid_time = False
    created = value["createdAt"]
    if isinstance(created,str) and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z",created):
        try:
            parsed=datetime.datetime.strptime(created,"%Y-%m-%dT%H:%M:%S.%fZ")
            valid_time=parsed.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]+"Z"==created
        except ValueError: pass
    name=value["repositoryName"]
    valid = (value["schemaVersion"]==1 and value["purpose"]=="production-policy-root-rotation" and integer(value["generation"]) and value["generation"]>=1 and isinstance(value["previousReceiptDigest"],str) and HEX(64).fullmatch(value["previousReceiptDigest"]) and (value["generation"]!=1 or value["previousReceiptDigest"]=="0"*64) and isinstance(value["repositoryId"],str) and re.fullmatch(r"\d+",value["repositoryId"]) and isinstance(name,str) and unicodedata.normalize("NFC",name)==name and re.fullmatch(r"[-A-Za-z0-9_.]+/[-A-Za-z0-9_.]+",name) and isinstance(value["policyCommit"],str) and HEX(40).fullmatch(value["policyCommit"]) and isinstance(value["policyTreeOid"],str) and HEX(40).fullmatch(value["policyTreeOid"]) and isinstance(value["bundleSha256"],str) and HEX(64).fullmatch(value["bundleSha256"]) and isinstance(value["anchorSha256"],str) and HEX(64).fullmatch(value["anchorSha256"]) and integer(value["anchorGeneration"]) and value["anchorGeneration"]>=1 and valid_time and isinstance(value["signerKeyId"],str) and re.fullmatch(r"[-A-Za-z0-9_.]+",value["signerKeyId"]))
    if not valid: abort("entry schema invalid")
    if (json.dumps(value,ensure_ascii=False,separators=(",",":"))+"\n").encode()!=raw: abort("entry bytes are not canonical")
    return raw

def main():
    global child,parent_fd,output_name,output_created,stage_name,stage_created
    if sys.platform!="linux":abort("Linux production host required")
    if len(sys.argv)!=4: abort("usage: signer <key> <entry> <output>")
    key_fd,key_info=open_input(sys.argv[1],{0o600}); entry_fd,entry_info=open_input(sys.argv[2],{0o444,0o644}); parent_fd,output_name=open_parent(sys.argv[3])
    key_handle=None
    try:
        key_handle,key_reference=secure_key_reference(stable_read(key_fd,key_info));entry=validate(stable_read(entry_fd,entry_info));signer_id=json.loads(entry)["signerKeyId"];prefix,recovered=scavenge_stages(entry,key_reference,key_handle,signer_id)
        if recovered:return
        old_mask=signal.pthread_sigmask(signal.SIG_BLOCK,CAUGHT)
        try:
            child=subprocess.Popen(["/usr/bin/ssh-keygen","-Y","sign","-n","steam-top-production-policy-root","-f",key_reference],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=(() if key_handle is None else (key_handle,)))
            if os.geteuid()!=0 and os.environ.get("STEAM_TOP_POLICY_SIGNER_TEST_SIGNAL_CHILD")=="1":os.kill(os.getpid(),signal.SIGTERM)
        finally:signal.pthread_sigmask(signal.SIG_SETMASK,old_mask)
        signature,error=child.communicate(entry)
        if child.returncode: raise RuntimeError(error.decode("utf-8","replace").strip() or "ssh-keygen failed")
        child=None
        stage_name=f"{prefix}{os.getpid()}-{os.urandom(8).hex()}";fd=os.open(stage_name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o400,dir_fd=parent_fd);stage_created=True
        try:
            offset=0
            while offset<len(signature): offset+=os.write(fd,signature[offset:])
            os.fsync(fd)
        finally: os.close(fd)
        if os.geteuid()!=0 and os.environ.get("STEAM_TOP_POLICY_SIGNER_TEST_KILL_STAGE")=="1":os.kill(os.getpid(),signal.SIGKILL)
        old_mask=signal.pthread_sigmask(signal.SIG_BLOCK,CAUGHT)
        try:
            os.link(stage_name,output_name,src_dir_fd=parent_fd,dst_dir_fd=parent_fd,follow_symlinks=False);output_created=True
            if os.geteuid()!=0 and os.environ.get("STEAM_TOP_POLICY_SIGNER_TEST_KILL_OUTPUT")=="1":os.kill(os.getpid(),signal.SIGKILL)
            if os.geteuid()!=0 and os.environ.get("STEAM_TOP_POLICY_SIGNER_TEST_SIGNAL_OUTPUT")=="1":os.kill(os.getpid(),signal.SIGTERM)
        finally:signal.pthread_sigmask(signal.SIG_SETMASK,old_mask)
        os.fsync(parent_fd);os.unlink(stage_name,dir_fd=parent_fd);stage_created=False
        if os.geteuid()!=0 and os.environ.get("STEAM_TOP_POLICY_SIGNER_TEST_KILL_AFTER_UNLINK")=="1":os.kill(os.getpid(),signal.SIGKILL)
        os.fsync(parent_fd);output_created=False
    finally:
        os.close(key_fd); os.close(entry_fd)
        if key_handle is not None:os.close(key_handle)

if __name__=="__main__":
    for caught in CAUGHT: signal.signal(caught,on_signal)
    try: main()
    except BaseException as error:
        if output_created and parent_fd is not None:
            try: os.unlink(output_name,dir_fd=parent_fd); os.fsync(parent_fd)
            except FileNotFoundError: pass
        if stage_created and parent_fd is not None:
            try:os.unlink(stage_name,dir_fd=parent_fd);os.fsync(parent_fd)
            except FileNotFoundError:pass
        print(str(error),file=sys.stderr); sys.exit(1)
    finally:
        if parent_fd is not None: os.close(parent_fd)
