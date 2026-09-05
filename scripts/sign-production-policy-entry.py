#!/usr/bin/python3
import ctypes, datetime, fcntl, hashlib, json, os, re, signal, stat, subprocess, sys, time, unicodedata

KEYS = ["schemaVersion","purpose","generation","previousReceiptDigest","repositoryId","repositoryName","policyCommit","policyTreeOid","bundleSha256","anchorSha256","anchorGeneration","createdAt","signerKeyId"]
HEX = lambda n: re.compile(rf"^[a-f0-9]{{{n}}}$")
child = None
parent_fd = None
output_name = None
output_created = False
stage_name = None
stage_created = False
stage_fd = None
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
    fd=os.memfd_create("steam-top-policy-key",0);os.fchmod(fd,0o600);offset=0
    while offset<len(key_data):offset+=os.write(fd,key_data[offset:])
    os.lseek(fd,0,os.SEEK_SET);return fd,f"/proc/self/fd/{fd}"

def verify_path_binding(name,signature_fd,expected_info):
    bound_fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent_fd)
    try:
        if identity(os.fstat(bound_fd))!=identity(expected_info) or identity(os.fstat(signature_fd))!=identity(expected_info):abort("verified signature output changed")
    finally:os.close(bound_fd)

def swap_output_for_test(variable="STEAM_TOP_POLICY_SIGNER_TEST_SWAP_OUTPUT_AFTER_VERIFY"):
    if os.geteuid()==0 or os.environ.get(variable)!="1":return
    os.unlink(output_name,dir_fd=parent_fd);fd=os.open(output_name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o400,dir_fd=parent_fd)
    try:os.write(fd,b"foreign");os.fsync(fd)
    finally:os.close(fd)
    os.fsync(parent_fd)

def swap_stage_for_test(name,variable):
    if os.geteuid()==0 or os.environ.get(variable)!="1":return
    preserved=f".{name}.verified-preserved";os.rename(name,preserved,src_dir_fd=parent_fd,dst_dir_fd=parent_fd)
    fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o400,dir_fd=parent_fd)
    try:os.write(fd,b"foreign");os.fsync(fd)
    finally:os.close(fd)
    os.fsync(parent_fd)

def quarantine_cleanup(name,fd,variable):
    expected=os.fstat(fd);verify_path_binding(name,fd,expected)
    swap_stage_for_test(name,variable);verify_path_binding(name,fd,expected)
    swap_stage_for_test(name,f"{variable}_AFTER_LAST_BIND")
    output_digest=hashlib.sha256(output_name.encode()).hexdigest();quarantine=f".steam-top-signature-quarantine-{output_digest}-{os.getpid()}-{os.urandom(8).hex()}"
    libc=ctypes.CDLL(None,use_errno=True)
    if libc.renameat2(parent_fd,name.encode(),parent_fd,quarantine.encode(),1)!=0:raise OSError(ctypes.get_errno(),"renameat2 no-clobber failed")
    quarantine_fd=os.open(quarantine,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent_fd)
    try:
        if identity(os.fstat(quarantine_fd))!=identity(expected) or identity(os.fstat(fd))!=identity(expected):abort("quarantined stage identity mismatch")
    finally:os.close(quarantine_fd)
    os.unlink(quarantine,dir_fd=parent_fd);os.fsync(parent_fd)

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
        if identity(os.fstat(signature_fd))!=identity(expected_info):abort("signature recovery changed")
        return signature_fd
    except BaseException:
        os.close(signature_fd);raise
    finally:
        if allowed_fd is not None:os.close(allowed_fd)

def safe_signature(info):return stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and stat.S_IMODE(info.st_mode)==0o400
def same_inode(left,right):return (left.st_dev,left.st_ino)==(right.st_dev,right.st_ino)

def recover_journal(journal,entry,key_reference,key_handle,signer_id,stage_prefix):
    try:journal_info=os.stat(journal,dir_fd=parent_fd,follow_symlinks=False)
    except FileNotFoundError:return False
    stages=[]
    for name in os.listdir(parent_fd):
        match=re.fullmatch(re.escape(stage_prefix)+r"([1-9][0-9]*)-([a-f0-9]{16})",name)
        if not match:continue
        info=os.stat(name,dir_fd=parent_fd,follow_symlinks=False)
        if not safe_signature(info) or not same_inode(info,journal_info):abort("unsafe published signature stage")
        try:os.kill(int(match.group(1)),0);abort("signature publication still active")
        except ProcessLookupError:pass
        except PermissionError:abort("signature publication ownership uncertain")
        fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent_fd)
        if identity(os.fstat(fd))!=identity(info):os.close(fd);abort("published signature stage changed")
        stages.append((name,info,fd))
    if len(stages)>1 or not safe_signature(journal_info) or journal_info.st_nlink!=1+len(stages)+(1 if path_exists(output_name) else 0):abort("unsafe signature journal links")
    signature_fd=verify_signature(journal,journal_info,entry,key_reference,key_handle,signer_id)
    try:
        swap_output_for_test()
        try:final_info=os.stat(output_name,dir_fd=parent_fd,follow_symlinks=False)
        except FileNotFoundError:
            os.link(journal,output_name,src_dir_fd=parent_fd,dst_dir_fd=parent_fd,follow_symlinks=False);os.fsync(parent_fd);final_info=os.stat(output_name,dir_fd=parent_fd,follow_symlinks=False)
        current=os.fstat(signature_fd)
        if not safe_signature(final_info) or not same_inode(final_info,current):abort("signature journal conflicts with final output")
        verify_path_binding(journal,signature_fd,current);verify_path_binding(output_name,signature_fd,current)
        swap_output_for_test("STEAM_TOP_POLICY_SIGNER_TEST_SWAP_OUTPUT_BEFORE_STAGE_UNLINK")
        verify_path_binding(output_name,signature_fd,current)
        for name,_,fd in stages:
            quarantine_cleanup(name,fd,"STEAM_TOP_POLICY_SIGNER_TEST_SWAP_RECOVERY_STAGE_BEFORE_CLEANUP")
        current=os.fstat(signature_fd)
        if current.st_nlink!=2:abort("unsafe permanent signature journal")
        verify_path_binding(journal,signature_fd,current);verify_path_binding(output_name,signature_fd,current);os.fsync(parent_fd)
        verify_path_binding(journal,signature_fd,current);verify_path_binding(output_name,signature_fd,current);return True
    finally:
        os.close(signature_fd)
        for _,_,fd in stages:os.close(fd)

def path_exists(name):
    try:os.stat(name,dir_fd=parent_fd,follow_symlinks=False);return True
    except FileNotFoundError:return False

def acquire_output_lock(output_digest):
    name=f".steam-top-signature-lock-{output_digest}";fd=os.open(name,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600,dir_fd=parent_fd);info=os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o600 or info.st_nlink!=1:os.close(fd);abort("unsafe signature publication lock")
    fcntl.flock(fd,fcntl.LOCK_EX);verify_path_binding(name,fd,info)
    test_barrier("STEAM_TOP_POLICY_SIGNER_TEST_LOCK_READY","STEAM_TOP_POLICY_SIGNER_TEST_LOCK_CONTINUE")
    verify_path_binding(name,fd,info)
    return fd

def test_barrier(ready_variable,continue_variable):
    if os.geteuid()!=0 and os.environ.get(ready_variable):
        ready=os.environ[ready_variable];go=os.environ.get(continue_variable,"")
        marker=os.open(ready,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);os.close(marker)
        for _ in range(1000):
            if go and os.path.exists(go):break
            time.sleep(0.01)
        else:abort("test barrier timeout")

def validate_namespace(output_digest,journal):
    journal_prefix=f".steam-top-signature-journal-{output_digest}-";matching=[];quarantine_prefix=f".steam-top-signature-quarantine-{output_digest}-"
    for name in os.listdir(parent_fd):
        if name.startswith(journal_prefix):
            if not re.fullmatch(re.escape(journal_prefix)+r"[a-f0-9]{64}",name):abort("malformed signature journal name")
            info=os.stat(name,dir_fd=parent_fd,follow_symlinks=False)
            if not safe_signature(info):abort("unsafe signature journal")
            matching.append(name)
        if name.startswith(quarantine_prefix):
            if not re.fullmatch(re.escape(quarantine_prefix)+r"[1-9][0-9]*-[a-f0-9]{16}",name):abort("malformed signature quarantine")
            abort("signature quarantine requires manual review")
    if len(matching)>1 or matching and matching[0]!=journal:abort("stale or ambiguous signature journal")

def prepare_recovery(entry,key_reference,key_handle,signer_id):
    output_digest=hashlib.sha256(output_name.encode()).hexdigest();entry_digest=hashlib.sha256(entry).hexdigest()
    stage_prefix=f".steam-top-signature-stage-{output_digest}-";journal_prefix=f".steam-top-signature-journal-{output_digest}-";journal=f"{journal_prefix}{entry_digest}"
    validate_namespace(output_digest,journal)
    if recover_journal(journal,entry,key_reference,key_handle,signer_id,stage_prefix):return stage_prefix,journal,True
    stages=[]
    for name in os.listdir(parent_fd):
        match=re.fullmatch(re.escape(stage_prefix)+r"([1-9][0-9]*)-([a-f0-9]{16})",name)
        if not match:continue
        info=os.stat(name,dir_fd=parent_fd,follow_symlinks=False)
        if not safe_signature(info) or info.st_nlink not in (1,2):abort("unsafe signature stage")
        try:os.kill(int(match.group(1)),0);abort("signature publication still active")
        except ProcessLookupError:pass
        except PermissionError:abort("signature publication ownership uncertain")
        fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent_fd)
        if identity(os.fstat(fd))!=identity(info):os.close(fd);abort("signature stage changed")
        stages.append((name,info,fd))
    if len(stages)>1:abort("ambiguous signature stages")
    if stages:
        name,info,stage_handle=stages[0]
        if info.st_nlink==1 and not path_exists(output_name):
            quarantine_cleanup(name,stage_handle,"STEAM_TOP_POLICY_SIGNER_TEST_SWAP_UNPUBLISHED_STAGE_BEFORE_CLEANUP");os.close(stage_handle)
        else:
            try:final_info=os.stat(output_name,dir_fd=parent_fd,follow_symlinks=False)
            except FileNotFoundError:abort("incomplete legacy signature publication")
            if info.st_nlink!=2 or not safe_signature(final_info) or not same_inode(info,final_info):abort("unsafe legacy signature publication")
            fd=verify_signature(name,info,entry,key_reference,key_handle,signer_id);os.close(fd);verify_path_binding(name,stage_handle,info)
            os.link(name,journal,src_dir_fd=parent_fd,dst_dir_fd=parent_fd,follow_symlinks=False);os.fsync(parent_fd)
            os.close(stage_handle)
            return stage_prefix,journal,recover_journal(journal,entry,key_reference,key_handle,signer_id,stage_prefix)
    if path_exists(output_name):
        info=os.stat(output_name,dir_fd=parent_fd,follow_symlinks=False)
        if not safe_signature(info) or info.st_nlink!=1:abort("unsafe existing signature output")
        fd=verify_signature(output_name,info,entry,key_reference,key_handle,signer_id);os.close(fd)
        os.link(output_name,journal,src_dir_fd=parent_fd,dst_dir_fd=parent_fd,follow_symlinks=False);os.fsync(parent_fd)
        return stage_prefix,journal,recover_journal(journal,entry,key_reference,key_handle,signer_id,stage_prefix)
    return stage_prefix,journal,False

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
    global child,parent_fd,output_name,output_created,stage_name,stage_created,stage_fd
    if sys.platform!="linux":abort("Linux production host required")
    if len(sys.argv)!=4: abort("usage: signer <key> <entry> <output>")
    key_fd,key_info=open_input(sys.argv[1],{0o600}); entry_fd,entry_info=open_input(sys.argv[2],{0o444,0o644}); parent_fd,output_name=open_parent(sys.argv[3])
    fcntl.flock(parent_fd,fcntl.LOCK_EX);output_digest=hashlib.sha256(output_name.encode()).hexdigest();lock_handle=acquire_output_lock(output_digest);key_handle=None;journal=None
    try:
        key_handle,key_reference=secure_key_reference(stable_read(key_fd,key_info));entry=validate(stable_read(entry_fd,entry_info));signer_id=json.loads(entry)["signerKeyId"];prefix,journal,recovered=prepare_recovery(entry,key_reference,key_handle,signer_id)
        if recovered:validate_namespace(output_digest,journal);return
        old_mask=signal.pthread_sigmask(signal.SIG_BLOCK,CAUGHT)
        try:
            child=subprocess.Popen(["/usr/bin/ssh-keygen","-Y","sign","-n","steam-top-production-policy-root","-f",key_reference],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=(() if key_handle is None else (key_handle,)))
            if os.geteuid()!=0 and os.environ.get("STEAM_TOP_POLICY_SIGNER_TEST_SIGNAL_CHILD")=="1":os.kill(os.getpid(),signal.SIGTERM)
        finally:signal.pthread_sigmask(signal.SIG_SETMASK,old_mask)
        signature,error=child.communicate(entry)
        if child.returncode: raise RuntimeError(error.decode("utf-8","replace").strip() or "ssh-keygen failed")
        child=None
        stage_name=f"{prefix}{os.getpid()}-{os.urandom(8).hex()}";stage_fd=os.open(stage_name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o400,dir_fd=parent_fd);stage_created=True
        try:
            offset=0
            while offset<len(signature): offset+=os.write(stage_fd,signature[offset:])
            os.fsync(stage_fd)
        except BaseException:
            os.close(stage_fd);stage_fd=None;raise
        stage_info=os.fstat(stage_fd)
        if os.geteuid()!=0 and os.environ.get("STEAM_TOP_POLICY_SIGNER_TEST_KILL_STAGE")=="1":os.kill(os.getpid(),signal.SIGKILL)
        if os.geteuid()!=0 and os.environ.get("STEAM_TOP_POLICY_SIGNER_TEST_FAIL_AFTER_STAGE")=="1":abort("test failure after stage")
        old_mask=signal.pthread_sigmask(signal.SIG_BLOCK,CAUGHT)
        try:
            swap_stage_for_test(stage_name,"STEAM_TOP_POLICY_SIGNER_TEST_SWAP_FRESH_STAGE_BEFORE_JOURNAL");verify_path_binding(stage_name,stage_fd,stage_info)
            os.link(stage_name,journal,src_dir_fd=parent_fd,dst_dir_fd=parent_fd,follow_symlinks=False);os.fsync(parent_fd)
            current=os.fstat(stage_fd);verify_path_binding(stage_name,stage_fd,current);verify_path_binding(journal,stage_fd,current)
            if os.geteuid()!=0 and os.environ.get("STEAM_TOP_POLICY_SIGNER_TEST_KILL_JOURNAL")=="1":os.kill(os.getpid(),signal.SIGKILL)
            os.link(journal,output_name,src_dir_fd=parent_fd,dst_dir_fd=parent_fd,follow_symlinks=False);os.fsync(parent_fd)
            current=os.fstat(stage_fd);verify_path_binding(stage_name,stage_fd,current);verify_path_binding(journal,stage_fd,current);verify_path_binding(output_name,stage_fd,current)
            verified_fd=verify_signature(journal,current,entry,key_reference,key_handle,signer_id);os.close(verified_fd)
            if os.geteuid()!=0 and os.environ.get("STEAM_TOP_POLICY_SIGNER_TEST_KILL_OUTPUT")=="1":os.kill(os.getpid(),signal.SIGKILL)
            if os.geteuid()!=0 and os.environ.get("STEAM_TOP_POLICY_SIGNER_TEST_SIGNAL_OUTPUT")=="1":os.kill(os.getpid(),signal.SIGTERM)
        finally:signal.pthread_sigmask(signal.SIG_SETMASK,old_mask)
        quarantine_cleanup(stage_name,stage_fd,"STEAM_TOP_POLICY_SIGNER_TEST_SWAP_FRESH_STAGE_BEFORE_CLEANUP");stage_created=False
        current=os.fstat(stage_fd)
        if current.st_nlink!=2:abort("unsafe fresh signature journal")
        verify_path_binding(journal,stage_fd,current);verify_path_binding(output_name,stage_fd,current)
        os.close(stage_fd);stage_fd=None
        if os.geteuid()!=0 and os.environ.get("STEAM_TOP_POLICY_SIGNER_TEST_KILL_AFTER_UNLINK")=="1":os.kill(os.getpid(),signal.SIGKILL)
        os.fsync(parent_fd);validate_namespace(output_digest,journal)
    except BaseException:
        test_barrier("STEAM_TOP_POLICY_SIGNER_TEST_CLEANUP_READY","STEAM_TOP_POLICY_SIGNER_TEST_CLEANUP_CONTINUE")
        if stage_created and stage_fd is not None:
            info=os.fstat(stage_fd)
            if info.st_nlink==1:
                try:quarantine_cleanup(stage_name,stage_fd,"STEAM_TOP_POLICY_SIGNER_TEST_SWAP_UNPUBLISHED_STAGE_BEFORE_CLEANUP")
                except (FileNotFoundError,ValueError):pass
        if journal is not None:validate_namespace(output_digest,journal)
        raise
    finally:
        if stage_fd is not None:os.close(stage_fd);stage_fd=None
        os.close(key_fd); os.close(entry_fd)
        if key_handle is not None:os.close(key_handle)
        try:verify_path_binding(f".steam-top-signature-lock-{output_digest}",lock_handle,os.fstat(lock_handle))
        finally:
            os.close(lock_handle);fcntl.flock(parent_fd,fcntl.LOCK_UN)

if __name__=="__main__":
    for caught in CAUGHT: signal.signal(caught,on_signal)
    try: main()
    except BaseException as error:
        print(str(error),file=sys.stderr); sys.exit(1)
    finally:
        if parent_fd is not None: os.close(parent_fd)
