#!/usr/bin/python3
import hashlib,json,os,stat,sys
MANIFEST="/etc/steam-top-bootstrap/policy-ceremony-manifest.json"
def fail(message):raise SystemExit(message)
def guarded(path,mode=None,directory=False):
 parts=os.path.abspath(path).split(os.sep);fd=os.open(os.sep,os.O_RDONLY|os.O_DIRECTORY)
 try:
  for part in parts[1:-1]:
   nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);s=os.fstat(nxt)
   if s.st_uid!=0 or s.st_mode&0o022:fail("unsafe ceremony parent")
   os.close(fd);fd=nxt
  flags=os.O_RDONLY|os.O_NOFOLLOW|(os.O_DIRECTORY if directory else 0);item=os.open(parts[-1],flags,dir_fd=fd);s=os.fstat(item)
  if s.st_uid!=0 or s.st_mode&0o022 or directory and not stat.S_ISDIR(s.st_mode) or not directory and (not stat.S_ISREG(s.st_mode) or s.st_nlink!=1) or mode is not None and stat.S_IMODE(s.st_mode)!=mode:fail("unsafe ceremony object")
  return item
 finally:os.close(fd)
def read(fd):
 data=b""
 while True:
  block=os.read(fd,65536)
  if not block:return data
  data+=block
def sha(fd):return hashlib.sha256(read(fd)).hexdigest()
mf=guarded(MANIFEST,0o400);raw=read(mf);os.close(mf);value=json.loads(raw);names=["verify-and-create-production-policy-entry.sh","verify-production-policy-anchor.mjs","create-production-policy-ledger-entry.mjs","verify-attestation-identity.mjs"]
canonical=(json.dumps({"schemaVersion":1,"purpose":"steam-top-production-policy-ceremony","generationPath":value.get("generationPath"),"files":value.get("files")},separators=(",",":"))+"\n").encode()
if raw!=canonical or list(value)!=["schemaVersion","purpose","generationPath","files"] or list(value.get("files",{}))!=names:fail("invalid ceremony manifest")
directory=guarded(value["generationPath"],0o555,True);os.close(directory);opened=[]
for name in names:
 fd=guarded(os.path.join(value["generationPath"],name),0o555 if name.endswith(".sh") else 0o444)
 if sha(fd)!=value["files"][name]:fail("ceremony digest mismatch")
 os.lseek(fd,0,os.SEEK_SET);opened.append(fd)
if len(sys.argv)==2 and sys.argv[1]=="--verify-install":
 for fd in opened:os.close(fd)
 print("verified");raise SystemExit(0)
if not os.path.isdir("/proc/self/fd"):fail("fd execution unavailable")
bash=guarded("/bin/bash");script=opened[0]
for fd in opened:os.set_inheritable(fd,True)
os.execve(bash,["/bin/bash",f"/proc/self/fd/{script}",*sys.argv[1:]],{"PATH":"/usr/bin:/bin:/usr/local/bin","LANG":"C","LC_ALL":"C","STEAM_TOP_CEREMONY_ROOT":value["generationPath"]})
