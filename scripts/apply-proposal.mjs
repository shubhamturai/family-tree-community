import fs from 'node:fs';
const body=process.env.ISSUE_BODY||'';
const m=body.match(/FG_PROPOSAL\s*\n([\s\S]*?)\nFG_PROPOSAL/);
if(!m) throw new Error('Missing FG_PROPOSAL block');
const p=JSON.parse(m[1]), d=JSON.parse(fs.readFileSync('data/family.json','utf8'));
d.persons ||= []; d.relationships ||= {parentChild:[],spouses:[]};
const id=x=>typeof x==='string'&&/^P\d{6}$/.test(x), has=x=>d.persons.some(p=>p.id===x), clean=x=>typeof x==='string'?x.trim():null;
const next=()=>`P${String(Math.max(0,...d.persons.map(x=>Number(x.id?.slice(1))||0))+1).padStart(6,'0')}`;
if(p.operation==='ADD_PERSON'){
 const x=p.payload||{}, display=clean(x.displayName)||[x.firstName,x.middleName,x.familyName].filter(Boolean).join(' ');
 if(!display) throw new Error('Name is required');
 if(d.persons.some(q=>q.displayName?.toLowerCase()===display.toLowerCase()&&x.dateOfBirth&&q.dateOfBirth===x.dateOfBirth)) throw new Error('Possible duplicate person');
 d.persons.push({id:next(),firstName:clean(x.firstName)||display,middleName:clean(x.middleName),familyName:clean(x.familyName),displayName:display,nickname:clean(x.nickname),maidenName:clean(x.maidenName),gender:clean(x.gender),dateOfBirth:clean(x.dateOfBirth),dateOfDeath:clean(x.dateOfDeath),lifeStatus:x.dateOfDeath?'deceased':clean(x.lifeStatus)||'unknown',birthPlace:clean(x.birthPlace),birthRegion:clean(x.birthRegion),birthCountry:clean(x.birthCountry),deathPlace:clean(x.deathPlace),currentLocation:clean(x.currentLocation),occupation:clean(x.occupation)||'',notes:clean(x.notes)||''});
} else if(p.operation==='UPDATE_PERSON'){
 const x=p.payload||{}, q=d.persons.find(z=>z.id===x.personId); if(!q||!id(x.personId)) throw new Error('Unknown person ID');
 for(const k of ['firstName','middleName','familyName','displayName','nickname','maidenName','gender','dateOfBirth','dateOfDeath','birthPlace','birthRegion','birthCountry','deathPlace','currentLocation','occupation','notes']) if(k in x) q[k]=clean(x[k]);
 q.lifeStatus=q.dateOfDeath?'deceased':clean(x.lifeStatus)||q.lifeStatus||'unknown';
} else if(p.operation==='ADD_PARENT_CHILD'){
 const x=p.payload||{}; if(!id(x.parentId)||!id(x.childId)||!has(x.parentId)||!has(x.childId)||x.parentId===x.childId) throw new Error('Invalid parent/child IDs');
 if(d.relationships.parentChild.some(r=>r.parentId===x.parentId&&r.childId===x.childId)) throw new Error('Relationship already exists');
 d.relationships.parentChild.push({parentId:x.parentId,childId:x.childId,role:clean(x.role)||'parent',order:Number(x.order)||1});
} else if(p.operation==='ADD_SPOUSE'){
 const x=p.payload||{}; if(!id(x.personAId)||!id(x.personBId)||!has(x.personAId)||!has(x.personBId)||x.personAId===x.personBId) throw new Error('Invalid spouse IDs');
 if(d.relationships.spouses.some(r=>new Set([r.personAId,r.personBId]).size===2&&[r.personAId,r.personBId].includes(x.personAId)&&[r.personAId,r.personBId].includes(x.personBId))) throw new Error('Spouse relationship already exists');
 d.relationships.spouses.push({personAId:x.personAId,personBId:x.personBId,order:Number(x.order)||1,marriageDate:clean(x.marriageDate),divorceDate:clean(x.divorceDate)});
} else throw new Error('Unsupported operation: '+p.operation);
d.lastUpdated=new Date().toISOString(); fs.writeFileSync('data/family.json',JSON.stringify(d,null,2)+'\n');