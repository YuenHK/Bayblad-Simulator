#!/usr/bin/env node
for(const name of ["PREVIOUS_RUN"])if(!/^[1-9][0-9]{0,19}$/u.test(process.env[name]??""))throw new Error(`${name} invalid`);
for(const name of ["PREVIOUS_ARTIFACT"])if(!/^approved-release-[a-f0-9]{40}$/u.test(process.env[name]??""))throw new Error(`${name} invalid`);
for(const name of ["PREVIOUS_SHA"])if(!/^[a-f0-9]{64}$/u.test(process.env[name]??""))throw new Error(`${name} invalid`);
for(const name of ["PREVIOUS_COMMIT"])if(!/^[a-f0-9]{40}$/u.test(process.env[name]??""))throw new Error(`${name} invalid`);
