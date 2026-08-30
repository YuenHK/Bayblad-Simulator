#!/usr/bin/env python3
import gzip,os,sys,tempfile
REASONS={"GNU_LONGNAME":41,"PAX":42,"SPARSE":43,"TRUNCATED":44,"BOMB":45,"HEADER":46}
def fail(reason): print(reason,file=sys.stderr);raise SystemExit(REASONS[reason])
if len(sys.argv)!=3:raise SystemExit(2)
archive,output=sys.argv[1:];compressed=os.stat(archive).st_size
if compressed<1 or compressed>8_388_608:fail("BOMB")
fd,path=tempfile.mkstemp(prefix=".steam-top-tar-",dir=os.path.dirname(os.path.realpath(output)));expanded=0
try:
 with os.fdopen(fd,"wb") as out,gzip.open(archive,"rb") as source:
  while chunk:=source.read(65536):
   expanded+=len(chunk)
   if expanded>16_777_216 or expanded>max(65_536,compressed*64):fail("BOMB")
   out.write(chunk)
 with open(path,"rb") as raw:
  offset=0;headers=0
  while offset<expanded:
   raw.seek(offset);header=raw.read(512)
   if len(header)!=512:fail("TRUNCATED")
   if header==bytes(512):
    if raw.read(512)!=bytes(512) or any(raw.read()):fail("TRUNCATED")
    break
   headers+=1
   if headers>65:fail("HEADER")
   flag=header[156:157]
   if flag in (b"L",b"K"):fail("GNU_LONGNAME")
   if flag in (b"x",b"g"):fail("PAX")
   if flag==b"S":fail("SPARSE")
   try:size=int(header[124:136].rstrip(b"\0 ") or b"0",8)
   except ValueError:fail("HEADER")
   if size<0 or size>2_097_152:fail("BOMB")
   offset+=512+((size+511)//512)*512
  if headers<1 or offset>expanded:fail("TRUNCATED")
 os.chmod(path,0o400);os.replace(path,output);path="";print("OK",expanded)
except (EOFError,gzip.BadGzipFile,OSError):fail("TRUNCATED")
finally:
 try:
  if path:os.unlink(path)
 except OSError:pass
