/*
 * Family Graph — generational tree layout (shared by the public page and Admin Studio).
 *
 * treeLayout(ids, parentChildLinks, spouseLinks) -> { [id]: {x, y} }
 *   - generations are rows (children below parents, spouses on the same row)
 *   - a person and their spouses form one block; blocks are ordered to limit crossings
 *     and then centred under their parents with a pool-adjacent-violators pass
 * Plain script (no modules) so it can be loaded with a <script> tag and unit-tested in Node.
 */
const NODE_W=150,NODE_H=56,GAP_X=26,GAP_Y=84;
function pav(desired,offset){
  /* Closest positions to `desired` that keep x[i]-offset[i] non-decreasing (pool-adjacent-violators). */
  const blocks=[];
  desired.forEach((d,i)=>{blocks.push({s:d-offset[i],n:1});while(blocks.length>1){const b=blocks[blocks.length-1],a=blocks[blocks.length-2];if(a.s/a.n<=b.s/b.n)break;a.s+=b.s;a.n+=b.n;blocks.pop()}});
  const out=[];blocks.forEach(b=>{const m=b.s/b.n;for(let k=0;k<b.n;k++)out.push(m+offset[out.length])});return out
}
function treeLayout(ids,pcs,sps){
  const has=new Set(ids),gen={},par={},chi={},sp={};
  ids.forEach(i=>{gen[i]=0;par[i]=[];chi[i]=[];sp[i]=[]});
  pcs.forEach(r=>{if(has.has(r.parentId)&&has.has(r.childId)&&r.parentId!==r.childId){par[r.childId].push(r.parentId);chi[r.parentId].push(r.childId)}});
  sps.forEach(r=>{if(has.has(r.personAId)&&has.has(r.personBId)&&r.personAId!==r.personBId){sp[r.personAId].push(r.personBId);sp[r.personBId].push(r.personAId)}});
  for(let n=0;n<ids.length+2;n++){let ch=false;ids.forEach(i=>{par[i].forEach(p=>{if(gen[i]<gen[p]+1){gen[i]=gen[p]+1;ch=true}});sp[i].forEach(o=>{if(gen[i]<gen[o]){gen[i]=gen[o];ch=true}})});if(!ch)break}
  /* A "unit" is a person plus their spouses on the same row; units are laid out as blocks. */
  const unitOf={},units=[];
  ids.forEach(i=>{if(unitOf[i]!==undefined)return;const members=[i];unitOf[i]=units.length;for(let k=0;k<members.length;k++)sp[members[k]].forEach(o=>{if(unitOf[o]===undefined&&gen[o]===gen[i]){unitOf[o]=units.length;members.push(o)}});units.push({members,gen:gen[i],par:new Set(),chi:new Set(),x:0,w:members.length*(NODE_W+GAP_X)-GAP_X})});
  ids.forEach(c=>par[c].forEach(p=>{const a=unitOf[p],b=unitOf[c];if(a!==b){units[b].par.add(a);units[a].chi.add(b)}}));
  const L=units.reduce((m,u)=>Math.max(m,u.gen),0),levels=Array.from({length:L+1},()=>[]);
  units.forEach((u,i)=>levels[u.gen].push(i));
  const slot=new Array(units.length).fill(0),reindex=()=>levels.forEach(lv=>lv.forEach((u,k)=>{slot[u]=k}));
  reindex();
  const mean=(set,def)=>{if(!set.size)return def;let s=0;set.forEach(u=>{s+=slot[u]});return s/set.size};
  for(let it=0;it<4;it++){
    for(let g=1;g<=L;g++){levels[g].sort((a,b)=>mean(units[a].par,slot[a]*1e-3)-mean(units[b].par,slot[b]*1e-3)||slot[a]-slot[b]);reindex()}
    for(let g=L-1;g>=0;g--){levels[g].sort((a,b)=>mean(units[a].chi,slot[a])-mean(units[b].chi,slot[b])||slot[a]-slot[b]);reindex()}
  }
  const sep=lv=>{const off=[0];for(let k=1;k<lv.length;k++)off.push(off[k-1]+(units[lv[k-1]].w+units[lv[k]].w)/2+GAP_X*1.5);return off};
  levels.forEach(lv=>{const off=sep(lv);lv.forEach((u,k)=>{units[u].x=off[k]})});
  const place=(g,rel)=>{const lv=levels[g];if(!lv.length)return;const des=lv.map(u=>{const set=rel(units[u]);if(!set.size)return units[u].x;let s=0;set.forEach(v=>{s+=units[v].x});return s/set.size});const xs=pav(des,sep(lv));lv.forEach((u,k)=>{units[u].x=xs[k]})};
  for(let it=0;it<8;it++){for(let g=1;g<=L;g++)place(g,u=>u.par);for(let g=L-1;g>=0;g--)place(g,u=>u.chi)}
  for(let g=1;g<=L;g++)place(g,u=>u.par);
  const pos={};let minX=Infinity;
  units.forEach(u=>{const left=u.x-u.w/2;u.members.forEach((id,k)=>{pos[id]={x:left+k*(NODE_W+GAP_X)+NODE_W/2,y:u.gen*(NODE_H+GAP_Y)};minX=Math.min(minX,pos[id].x)})});
  if(isFinite(minX))ids.forEach(i=>{pos[i].x-=minX});
  return pos
}

/*
 * branchView(ids, parentChildLinks, spouseLinks, collapsed) -> { visible:Set, hidden:{[id]:n}, canCollapse:Set }
 *   Collapsing a person hides the people who are only reachable through them: their descendants, and the
 *   married-in partners of those descendants. A child stays visible if another, non-collapsed parent shows them.
 *   Spouses of anyone visible are always visible, so a collapsed couple stays together.
 *   hidden[id] is how many people collapsing `id` (alone, given the rest) is hiding; canCollapse = people with children.
 */
function branchView(ids,pcs,sps,collapsed){
  const have=new Set(ids),kids=new Map(),pars=new Map(),mates=new Map();
  const add=(m,k,v)=>{(m.get(k)||m.set(k,[]).get(k)).push(v)};
  pcs.forEach(r=>{if(have.has(r.parentId)&&have.has(r.childId)){add(kids,r.parentId,r.childId);add(pars,r.childId,r.parentId)}});
  sps.forEach(r=>{if(have.has(r.personAId)&&have.has(r.personBId)){add(mates,r.personAId,r.personBId);add(mates,r.personBId,r.personAId)}});
  const canCollapse=new Set(kids.keys());
  /* Where a walk starts: parentless people, except those married into someone who has parents (they belong to that branch). */
  const seeds=ids.filter(x=>!pars.has(x)&&!(mates.get(x)||[]).some(m=>pars.has(m)));
  const walk=skip=>{
    const vis=new Set(),st=[],see=x=>{if(!vis.has(x)){vis.add(x);st.push(x)}};
    seeds.forEach(see);
    while(st.length){
      const x=st.pop();(mates.get(x)||[]).forEach(see);
      if(skip.has(x))continue;
      (kids.get(x)||[]).forEach(c=>{if(!(pars.get(c)||[]).some(p=>p!==x&&skip.has(p)))see(c)})
    }
    return vis
  };
  const want=new Set([...(collapsed||[])].filter(x=>canCollapse.has(x)));
  if(!want.size)return{visible:new Set(ids),hidden:{},canCollapse};
  const first=walk(want),eff=new Set([...want].filter(x=>first.has(x))),visible=walk(eff),hidden={};
  eff.forEach(x=>{const rest=new Set(eff);rest.delete(x);hidden[x]=walk(rest).size-visible.size});
  if(!visible.size)return{visible:new Set(ids),hidden:{},canCollapse};   // corrupt data (a loop): show everyone rather than no one
  return{visible,hidden,canCollapse}
}

/* unfold(ids, parentChildLinks, spouseLinks, collapsed, id) -> a Set like `collapsed` in which `id` is visible, opening the nearest folds first. */
function unfold(ids,pcs,sps,collapsed,id){
  const next=new Set(collapsed||[]);
  if(!next.size||branchView(ids,pcs,sps,next).visible.has(id))return next;
  const seen=new Set([id]);let frontier=[id];
  while(frontier.length){
    const nxt=[];
    for(const x of frontier){
      const around=[...pcs.filter(r=>r.childId===x).map(r=>r.parentId),...sps.filter(r=>r.personAId===x||r.personBId===x).map(r=>r.personAId===x?r.personBId:r.personAId)];
      for(const y of around){
        if(seen.has(y))continue;seen.add(y);nxt.push(y);
        if(next.delete(y)&&branchView(ids,pcs,sps,next).visible.has(id))return next
      }
    }
    frontier=nxt
  }
  return next
}
