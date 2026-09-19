import fs from 'node:fs';

const body=process.env.ISSUE_BODY||'';
const m=body.match(/FG_PROPOSAL\s*\n([\s\S]*?)\nFG_PROPOSAL/);
if(!m) throw new Error('Missing FG_PROPOSAL block');

const proposal=JSON.parse(m[1]);
const d=JSON.parse(fs.readFileSync('data/family.json','utf8'));
d.persons ||= [];
d.relationships ||= {parentChild:[],spouses:[]};
d.relationships.parentChild ||= [];
d.relationships.spouses ||= [];

const validId=x=>typeof x==='string'&&/^P\d{6}$/.test(x);
const has=x=>d.persons.some(p=>p.id===x);
const clean=x=>typeof x==='string'?x.trim():null;
const nextId=()=>`P${String(Math.max(0,...d.persons.map(x=>Number(x.id?.slice(1))||0))+1).padStart(6,'0')}`;

function applyOne(proposal){
if(proposal.operation==='ADD_PERSON'){
  const x=proposal.payload||{};
  const display=clean(x.displayName)||[x.firstName,x.middleName,x.familyName].filter(Boolean).join(' ');
  if(!display) throw new Error('Name is required');
  if(x.dateOfDeath&&x.dateOfBirth&&x.dateOfDeath<x.dateOfBirth) throw new Error('Death date cannot precede birth date');
  if(d.persons.some(q=>q.recordStatus!=='deleted'&&q.displayName?.toLowerCase()===display.toLowerCase()&&x.dateOfBirth&&q.dateOfBirth===x.dateOfBirth)) throw new Error('Possible duplicate person');
  d.persons.push({
    id:nextId(),firstName:clean(x.firstName)||display,middleName:clean(x.middleName),
    familyName:clean(x.familyName),displayName:display,nickname:clean(x.nickname),
    maidenName:clean(x.maidenName),gender:clean(x.gender),dateOfBirth:clean(x.dateOfBirth),
    dateOfDeath:clean(x.dateOfDeath),lifeStatus:x.dateOfDeath?'deceased':clean(x.lifeStatus)||'unknown',
    birthPlace:clean(x.birthPlace),birthRegion:clean(x.birthRegion),birthCountry:clean(x.birthCountry),
    deathPlace:clean(x.deathPlace),currentLocation:clean(x.currentLocation),
    occupation:clean(x.occupation)||'',notes:clean(x.notes)||'',maritalStatus:clean(x.maritalStatus)||'unknown',isMarried:Boolean(x.isMarried),photoDataUrl:clean(x.photoDataUrl),recordStatus:'active'
  });

} else if(proposal.operation==='UPDATE_PERSON'){
  const x=proposal.payload||{}, q=d.persons.find(z=>z.id===x.personId);
  if(!q||!validId(x.personId)||q.recordStatus==='deleted') throw new Error('Unknown or archived person ID');
  for(const k of ['firstName','middleName','familyName','displayName','nickname','maidenName','gender','dateOfBirth','dateOfDeath','birthPlace','birthRegion','birthCountry','deathPlace','currentLocation','occupation','notes','maritalStatus','photoDataUrl'])
    if(k in x) q[k]=clean(x[k]);
  if(q.dateOfDeath&&q.dateOfBirth&&q.dateOfDeath<q.dateOfBirth) throw new Error('Death date cannot precede birth date');
  q.lifeStatus=q.dateOfDeath?'deceased':clean(x.lifeStatus)||q.lifeStatus||'unknown'; if('isMarried' in x) q.isMarried=Boolean(x.isMarried); else if('maritalStatus' in x) q.isMarried=q.maritalStatus==='married';

} else if(proposal.operation==='DELETE_PERSON'){
  const x=proposal.payload||{}, q=d.persons.find(z=>z.id===x.personId);
  if(!q||!validId(x.personId)) throw new Error('Unknown person ID');
  if(q.recordStatus==='deleted') throw new Error('Person is already archived');
  q.recordStatus='deleted';
  q.archivedAt=new Date().toISOString();
  q.archiveReason=clean(x.reason)||'Approved deletion/archive proposal';

} else if(proposal.operation==='ADD_PARENT_CHILD'){
  const x=proposal.payload||{};
  if(!validId(x.parentId)||!validId(x.childId)||!has(x.parentId)||!has(x.childId)||x.parentId===x.childId) throw new Error('Invalid parent/child IDs');
  if(d.persons.find(q=>q.id===x.parentId)?.recordStatus==='deleted'||d.persons.find(q=>q.id===x.childId)?.recordStatus==='deleted') throw new Error('Cannot relate archived people');
  if(d.relationships.parentChild.some(r=>r.parentId===x.parentId&&r.childId===x.childId)) throw new Error('Relationship already exists');
  d.relationships.parentChild.push({parentId:x.parentId,childId:x.childId,role:clean(x.role)||'parent',order:Number(x.order)||1});

} else if(proposal.operation==='ADD_SPOUSE'){
  const x=proposal.payload||{};
  if(!validId(x.personAId)||!validId(x.personBId)||!has(x.personAId)||!has(x.personBId)||x.personAId===x.personBId) throw new Error('Invalid spouse IDs');
  if(d.persons.find(q=>q.id===x.personAId)?.recordStatus==='deleted'||d.persons.find(q=>q.id===x.personBId)?.recordStatus==='deleted') throw new Error('Cannot relate archived people');
  if(d.relationships.spouses.some(r=>new Set([r.personAId,r.personBId]).size===2&&[r.personAId,r.personBId].includes(x.personAId)&&[r.personAId,r.personBId].includes(x.personBId))) throw new Error('Spouse relationship already exists');
  d.relationships.spouses.push({personAId:x.personAId,personBId:x.personBId,order:Number(x.order)||1,marriageDate:clean(x.marriageDate),marriagePlace:clean(x.marriagePlace),status:clean(x.status)||'married',divorceDate:clean(x.divorceDate)}); const a=d.persons.find(q=>q.id===x.personAId), b=d.persons.find(q=>q.id===x.personBId); if(a){a.maritalStatus=(x.status==='married'?'married':clean(x.status)||'unknown');a.isMarried=a.maritalStatus==='married'} if(b){b.maritalStatus=(x.status==='married'?'married':clean(x.status)||'unknown');b.isMarried=b.maritalStatus==='married'}

} else throw new Error('Unsupported operation: '+proposal.operation);

}

function savePhoto(person){
  if(!person?.photoDataUrl) return;
  const m=String(person.photoDataUrl).match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/);
  if(!m) throw new Error('Invalid profile photo data');
  const ext=m[1]==='jpg'?'jpg':m[1];
  fs.mkdirSync('data/photos',{recursive:true});
  fs.writeFileSync(`data/photos/${person.id}.${ext}`,Buffer.from(m[2],'base64'));
  person.photoUrl=`./data/photos/${person.id}.${ext}`;
  delete person.photoDataUrl;
}

if(proposal.operation==='BATCH_UPDATE'){
  const p=proposal.payload||{};
  if(p.baseLastUpdated && p.baseLastUpdated!==d.lastUpdated) throw new Error('Stale proposal: the family graph changed after this edit started. Please reload and submit again.');
  const list=Array.isArray(p.changes)?p.changes:[];
  if(!list.length) throw new Error('Batch contains no changes');
  for(const c of list){
    if(!c?.type) throw new Error('Invalid batch change');
    applyOne({operation:c.type,payload:c.payload||{}});
  }
}
else applyOne(proposal);

for(const p of d.persons) if(p.photoDataUrl) savePhoto(p);
d.lastUpdated=new Date().toISOString();
fs.writeFileSync('data/family.json',JSON.stringify(d,null,2)+'\\n');
console.log('Applied '+proposal.operation);
