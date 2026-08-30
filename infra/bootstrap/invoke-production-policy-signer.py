#!/usr/bin/python3
import hashlib,json,os,re,stat,sys,time
MANIFEST="/etc/steam-top-bootstrap/policy-signer-manifest.json";OWNER=0;TEST_ONLY=False
if os.geteuid()!=0 and len(sys.argv)>2 and sys.argv[1] in ("--test-manifest","--test-exec-manifest"):MANIFEST=sys.argv[2];OWNER=os.getuid();TEST_ONLY=sys.argv[1]=="--test-manifest";del sys.argv[1:3]
if os.geteuid()==0 and len(sys.argv)>1 and sys.argv[1]=="--verify-install":TEST_ONLY=True;del sys.argv[1]
KEYS=["schemaVersion","purpose","signerPath","signerSha256","pythonPath","pythonSha256","pythonStat"]
def fail(message):raise SystemExit(message)
def guarded(path,mode=None):
 parts=os.path.abspath(path).split(os.sep);fd=os.open(os.sep,os.O_RDONLY|os.O_DIRECTORY)
 try:
  for part in parts[1:-1]:
   nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);s=os.fstat(nxt)
   if s.st_uid not in (0,OWNER) or s.st_mode&0o022:fail("unsafe installed parent")
   os.close(fd);fd=nxt
  item=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd);s=os.fstat(item)
  if not stat.S_ISREG(s.st_mode) or s.st_uid not in (0,OWNER) or s.st_nlink!=1 or s.st_mode&0o022 or mode is not None and stat.S_IMODE(s.st_mode)!=mode:fail("unsafe installed file")
  return item,s
 finally:os.close(fd)
def digest(fd):
 h=hashlib.sha256();os.lseek(fd,0,os.SEEK_SET)
 while True:
  data=os.read(fd,65536)
  if not data:break
  h.update(data)
 return h.hexdigest()
mf,_=guarded(MANIFEST,0o400);raw=b""
while True:
 chunk=os.read(mf,65536)
 if not chunk:break
 raw+=chunk
value=json.loads(raw);canonical=(json.dumps(value,separators=(",",":"))+"\n").encode()
if raw!=canonical or list(value)!=KEYS or value["schemaVersion"]!=1 or value["purpose"]!="steam-top-production-policy-signer" or not re.fullmatch(r"[a-f0-9]{64}",value["signerSha256"]) or not re.fullmatch(r"[a-f0-9]{64}",value["pythonSha256"]):fail("invalid signer manifest")
signer,ss=guarded(value["signerPath"],0o444);runtime,rs=guarded(value["pythonPath"])
fields=lambda s:{"dev":s.st_dev,"ino":s.st_ino,"size":s.st_size,"mtimeNs":s.st_mtime_ns,"ctimeNs":s.st_ctime_ns,"uid":s.st_uid,"mode":stat.S_IMODE(s.st_mode),"nlink":s.st_nlink}
if digest(signer)!=value["signerSha256"] or digest(runtime)!=value["pythonSha256"] or fields(rs)!=value["pythonStat"]:fail("installed signer or runtime mismatch")
os.close(mf)
if TEST_ONLY:os.close(signer);os.close(runtime);print("verified");raise SystemExit(0)
if os.geteuid()!=0 and os.environ.get("STEAM_TOP_INVOKER_TEST_READY") and os.environ.get("STEAM_TOP_INVOKER_TEST_CONTINUE"):
 open(os.environ["STEAM_TOP_INVOKER_TEST_READY"],"x").close()
 while not os.path.exists(os.environ["STEAM_TOP_INVOKER_TEST_CONTINUE"]):time.sleep(.01)
if not os.path.isdir("/proc/self/fd"):fail("fd execution unavailable")
os.set_inheritable(signer,True)
os.execve(runtime,[value["pythonPath"],"-I","-E","-S",f"/proc/self/fd/{signer}",*sys.argv[1:]],{"PATH":"/usr/bin:/bin","LANG":"C","LC_ALL":"C","PYTHONNOUSERSITE":"1"})
