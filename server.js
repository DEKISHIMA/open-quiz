const express=require('express');
const http=require('http');
const {Server}=require('socket.io');
const crypto=require('crypto');
const app=express();
const server=http.createServer(app);
const io=new Server(server,{maxHttpBufferSize:8e6, pingInterval:10000, pingTimeout:20000});
const rooms=new Map();
const ROOM_TTL=30*60*1000;
app.use(express.static('public'));
const makeCode=()=>crypto.randomBytes(3).toString('hex').toUpperCase();
const makeToken=()=>crypto.randomBytes(18).toString('hex');
function publicPlayers(r){return [...r.players.values()].map(p=>({id:p.id,name:p.name,group:p.group,locked:p.locked,connected:p.connected!==false}))}
function emitState(code){const r=rooms.get(code);if(!r)return;io.to(code).emit('state',{question:r.questions[r.current-1]||'',current:r.current,total:r.questions.length,phase:r.phase,remaining:r.remaining,players:publicPlayers(r)});}
function stopTimer(r){if(r.timer){clearInterval(r.timer);r.timer=null;}}
function startTimer(code,reset=true){const r=rooms.get(code);if(!r)return;stopTimer(r);if(reset)r.remaining=90;emitState(code);r.timer=setInterval(()=>{if(!rooms.has(code)){stopTimer(r);return} if(r.phase!=='answer'){stopTimer(r);return} r.remaining--;io.to(code).emit('timer',{remaining:r.remaining});if(r.remaining<=0){stopTimer(r);r.players.forEach(p=>{if(!p.locked){p.locked=true;p.answer=p.answer||'';}});r.phase='answerEnded';emitState(code);io.to(r.host).emit('timeUp');}},1000)}
function newQuestion(code){const r=rooms.get(code);if(!r)return;stopTimer(r);r.phase='answer';r.players.forEach(p=>{p.locked=false;p.answer=''});startTimer(code);io.to(code).emit('question',{number:r.current,total:r.questions.length,text:r.questions[r.current-1]||''});emitState(code);}
function finalSummary(r){const rows=[...r.players.values()].map(p=>{let score=0;for(const g of r.results.values())if(g[p.id]==='correct')score++;return{id:p.id,name:p.name,group:p.group,score}});const gm={};for(const x of rows)gm[x.group]=(gm[x.group]||0)+x.score;return{rows:rows.sort((a,b)=>b.score-a.score),groups:Object.entries(gm).map(([group,score])=>({group,score})).sort((a,b)=>b.score-a.score)}}
function cleanupRoom(code){const r=rooms.get(code);if(!r)return;stopTimer(r);rooms.delete(code)}
function scheduleCleanup(code){const r=rooms.get(code);if(!r)return;r.cleanupAt=Date.now()+ROOM_TTL;setTimeout(()=>{const x=rooms.get(code);if(x&&x.cleanupAt<=Date.now())cleanupRoom(code)},ROOM_TTL+100)}
io.on('connection',s=>{
 s.on('create',()=>{let c;do c=makeCode();while(rooms.has(c));const token=makeToken();rooms.set(c,{host:s.id,hostToken:token,questions:['日本で一番高い山は？'],current:1,phase:'setup',players:new Map,results:new Map,remaining:90,cleanupAt:0,timer:null});s.data.room=c;s.data.host=true;s.data.token=token;s.join(c);s.emit('created',{code:c,token});emitState(c)});
 s.on('resumeHost',d=>{const code=String(d.code||'').toUpperCase(),r=rooms.get(code);if(!r||r.hostToken!==d.token)return s.emit('err','司会者の再接続情報が見つかりません。');r.host=s.id;s.data.room=code;s.data.host=true;s.data.token=d.token;s.join(code);r.cleanupAt=0;emitState(code);if(r.phase==='answer'&&r.remaining>0){startTimer(code,false)}s.emit('resumedHost');});
 s.on('join',d=>{const code=String(d.code||'').toUpperCase(),r=rooms.get(code);if(!r)return s.emit('err','部屋がありません。');if(r.players.size>=8)return s.emit('err','8人で満員です。');const token=makeToken();const p={id:s.id,token,name:String(d.name||'PLAYER').slice(0,20),group:String(d.group||'グループ').slice(0,20),locked:false,answer:'',connected:true};r.players.set(token,p);s.data.room=code;s.data.playerToken=token;s.join(code);s.emit('joined',{number:r.current,total:r.questions.length,text:r.questions[r.current-1]||'',token});emitState(code)});
 s.on('resumePlayer',d=>{const code=String(d.code||'').toUpperCase(),r=rooms.get(code),p=r&&r.players.get(d.token);if(!r||!p)return s.emit('err','参加情報が見つかりません。');p.id=s.id;p.connected=true;s.data.room=code;s.data.playerToken=d.token;s.join(code);r.cleanupAt=0;s.emit('resumedPlayer',{number:r.current,total:r.questions.length,text:r.questions[r.current-1]||'',locked:p.locked});emitState(code);if(r.phase==='reveal'){const result=r.results.get(r.current)?.[p.token];if(result)s.emit('myVerdict',{number:r.current,result})}});
 s.on('questions',qs=>{const r=rooms.get(s.data.room);if(!r||r.host!==s.id||r.phase!=='setup')return;const a=Array.isArray(qs)?qs.map(x=>String(x||'').slice(0,300)).filter((_,i)=>i<20):[];if(!a.length)return s.emit('err','1問以上入力してください。');r.questions=a;r.current=1;r.results=new Map();r.players.forEach(p=>{p.locked=false;p.answer=''});newQuestion(s.data.room)});
 s.on('lock',answer=>{const r=rooms.get(s.data.room),p=r&&[...r.players.values()].find(x=>x.id===s.id);if(!p||r.phase!=='answer'||p.locked)return;p.locked=true;p.answer=String(answer||'').slice(0,800000);emitState(s.data.room)});
 s.on('startGrading',()=>{const r=rooms.get(s.data.room);if(!r||r.host!==s.id)return;if(!r.players.size||[...r.players.values()].some(p=>!p.locked))return s.emit('err','全員のLOCKを待ってください。');stopTimer(r);r.phase='grading';s.emit('grading',[...r.players.values()].map(p=>({id:p.id,name:p.name,group:p.group,answer:p.answer||''})));emitState(s.data.room)});
 s.on('publishGrades',grades=>{const r=rooms.get(s.data.room);if(!r||r.host!==s.id||r.phase!=='grading')return;const g={};for(const p of r.players.values()){if(!grades||!['correct','wrong'].includes(grades[p.id]))return s.emit('err','全員の〇×を決めてください。');g[p.token]=grades[p.id]}r.results.set(r.current,g);r.phase='reveal';const published=[...r.players.values()].map(p=>({id:p.id,name:p.name,group:p.group,answer:p.answer||'',result:g[p.token]}));s.emit('published',published);for(const p of r.players.values())if(p.id)io.to(p.id).emit('myVerdict',{number:r.current,result:g[p.token]});emitState(s.data.room)});
 s.on('next',()=>{const r=rooms.get(s.data.room);if(!r||r.host!==s.id||r.phase!=='reveal')return;if(r.current>=r.questions.length){r.phase='final';io.to(s.data.room).emit('final',finalSummary(r));emitState(s.data.room);return}r.current++;newQuestion(s.data.room)});
 s.on('reset',()=>{const r=rooms.get(s.data.room);if(!r||r.host!==s.id)return;newQuestion(s.data.room)});
 s.on('disconnect',()=>{const c=s.data.room,r=c&&rooms.get(c);if(!r)return;if(r.host===s.id){r.host=null;scheduleCleanup(c);io.to(c).emit('hostDisconnected')}else{const p=r.players.get(s.data.playerToken);if(p){p.connected=false;p.id=null}emitState(c);scheduleCleanup(c)}});
});
server.listen(process.env.PORT||3000,()=>console.log('OPEN QUIZ v6 running'));
