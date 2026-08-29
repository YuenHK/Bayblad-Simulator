#!/usr/bin/env node
import {execFileSync} from "node:child_process";
const [repo,name]=process.argv.slice(2);
if(!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/u.test(repo??"")||!/^[-A-Za-z0-9_.]+$/u.test(name??""))throw new Error("invalid environment lookup");
const value=JSON.parse(execFileSync("gh",["api",`repos/${repo}/environments/${name}`],{encoding:"utf8"}));
const reviewers=(value.protection_rules??[]).find((rule)=>rule.type==="required_reviewers")?.reviewers??[],policy=value.deployment_branch_policy;
if(reviewers.length<1||!policy||(policy.protected_branches!==true&&policy.custom_branch_policies!==true))throw new Error("environment lacks reviewers or restrictive branch policy");
