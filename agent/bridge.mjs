import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {actions} from './rules.mjs';
export class ModBridge {
 constructor(gamePath){this.root=path.join(path.resolve(gamePath),'scripts','MazLiveKOTH');}
 status(){
  const file=path.join(this.root,'status.json');
  const s=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  if(s.protocol!==2||!/^[a-f0-9]{32}$/.test(s.session)||!Number.isFinite(s.updatedAt))throw Error('Incompatible mod protocol');
  if(Date.now()-s.updatedAt>5000||s.updatedAt>Date.now()+5000)throw Error('Mod offline or clock skew');
  return s;
 }
 send(action,{count=1,name='Test',id=randomUUID()}={}){
  if(!actions.includes(action))throw Error('Unknown action');
  if(!Number.isInteger(count)||count<1||count>12)throw Error('Count must be 1..12');
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(id))throw Error('Invalid command ID');
  const s=this.status();
  if(!['start','stop','clear'].includes(action)&&s.phase!=='running')throw Error('Round not running');
  const inbox=path.join(this.root,'inbox');fs.mkdirSync(inbox,{recursive:true});
  if(fs.readdirSync(inbox).filter(f=>f.endsWith('.cmd')).length>=100)throw Error('Queue full');
  const safe=Array.from(String(name).replace(/[\p{C}~]/gu,' ')).slice(0,32).join('');
  const file=path.join(inbox,`${String(Date.now()).padStart(13,'0')}-${id}.cmd`);
  const temp=file+'.'+randomUUID()+'.tmp';
  fs.writeFileSync(temp,[Date.now(),action,count,Buffer.from(safe).toString('base64'),id,s.session,2].join('\t'),{flag:'wx'});
  fs.renameSync(temp,file);
  return {id,session:s.session,status:'sent'};
 }
 ack(ticket){
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(ticket.id))throw Error('Invalid command ID');
  try{
   const a=JSON.parse(fs.readFileSync(path.join(this.root,'acks',ticket.id+'.json'),'utf8'));
   if(a.session!==ticket.session||a.id!==ticket.id||a.protocol!==2)throw Error('ACK mismatch');
   return a;
  }catch(e){if(e.code==='ENOENT')return null;throw e;}
 }
}
