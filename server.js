const express=require('express');
const http=require('http');
const {Server}=require('socket.io');
const crypto=require('crypto');
const path=require('path');
const fs=require('fs');
const app=express();
const server=http.createServer(app);
const io=new Server(server,{maxHttpBufferSize:20e6,pingInterval:10000,pingTimeout:20000});
const rooms=new Map();
const ADMIN_PASSWORD='kashikoihito';
const adminTokens=new Set();
function isAdmin(req){return adminTokens.has(String(req.get('x-admin-token')||''))}
const DATA_DIR=path.join(__dirname,'data');
const SETS_FILE=path.join(DATA_DIR,'problem_sets.json');
if(!fs.existsSync(DATA_DIR))fs.mkdirSync(DATA_DIR,{recursive:true});
let problemSets=[];
try{problemSets=JSON.parse(fs.readFileSync(SETS_FILE,'utf8'));if(!Array.isArray(problemSets))problemSets=[]}catch(e){problemSets=[]}
function saveProblemSets(){fs.writeFileSync(SETS_FILE,JSON.stringify(problemSets,null,2),'utf8')}
function publicSet(x){return {id:x.id,name:x.name,questions:x.questions,updatedAt:x.updatedAt}}
const ROOM_TTL=30*60*1000;
app.use(express.json({limit:'20mb'}));
app.get('/api/problem-sets',(req,res)=>{if(!isAdmin(req))return res.status(401).json({error:'司会者ログインが必要です。'});res.json(problemSets.map(publicSet))});
app.post('/api/problem-sets',(req,res)=>{if(!isAdmin(req))return res.status(401).json({error:'司会者ログインが必要です。'});const name=String(req.body?.name||'').trim().slice(0,60);const qs=Array.isArray(req.body?.questions)?req.body.questions.map(normalizeQuestion).filter(q=>q.text.trim()).slice(0,5):[];if(!name||qs.length!==5)return res.status(400).json({error:'セット名と5問が必要です。'});const x={id:crypto.randomBytes(8).toString('hex'),name,questions:qs,updatedAt:Date.now()};problemSets.push(x);saveProblemSets();res.json(publicSet(x))});
app.put('/api/problem-sets/:id',(req,res)=>{if(!isAdmin(req))return res.status(401).json({error:'司会者ログインが必要です。'});const x=problemSets.find(v=>v.id===req.params.id);if(!x)return res.status(404).json({error:'セットが見つかりません。'});const name=String(req.body?.name||'').trim().slice(0,60);const qs=Array.isArray(req.body?.questions)?req.body.questions.map(normalizeQuestion).filter(q=>q.text.trim()).slice(0,5):[];if(!name||qs.length!==5)return res.status(400).json({error:'セット名と5問が必要です。'});x.name=name;x.questions=qs;x.updatedAt=Date.now();saveProblemSets();res.json(publicSet(x))});
app.delete('/api/problem-sets/:id',(req,res)=>{if(!isAdmin(req))return res.status(401).json({error:'司会者ログインが必要です。'});const n=problemSets.length;problemSets=problemSets.filter(v=>v.id!==req.params.id);if(problemSets.length===n)return res.status(404).json({error:'セットが見つかりません。'});saveProblemSets();res.json({ok:true})});
app.use(express.static(path.join(__dirname,'public')));
app.get('/display',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
const makeCode=()=>crypto.randomBytes(3).toString('hex').toUpperCase();
const makeToken=()=>crypto.randomBytes(18).toString('hex');
const normalizeQuestion=q=>typeof q==='string'?{text:String(q).slice(0,300),image:''}:{text:String(q?.text||'').slice(0,300),image:typeof q?.image==='string'?q.image:''};
function currentQuestion(r){return r.questions[r.current-1]||{text:'',image:''}}
function publicPlayers(r){return [...r.players.values()].map(p=>({id:p.id,name:p.name,group:p.group,locked:p.locked,connected:p.connected!==false}))}
function statePayload(r){
  const payload={question:currentQuestion(r),current:r.current,total:r.questions.length,phase:r.phase,remaining:r.remaining,players:publicPlayers(r)};
  if(r.phase==='reveal'){
    const g=r.results.get(r.current)||{};
    payload.published=[...r.players.values()].map(p=>({id:p.id,name:p.name,group:p.group,answer:p.answer||'',result:g[p.token]}));
  }
  if(r.phase==='final') payload.final=finalSummary(r);
  return payload;
}
function emitState(code){const r=rooms.get(code);if(r)io.to(code).emit('state',statePayload(r));}
function stopTimer(r){if(r.timer){clearInterval(r.timer);r.timer=null}}
function startTimer(code,reset=true){const r=rooms.get(code);if(!r)return;stopTimer(r);if(reset)r.remaining=90;emitState(code);r.timer=setInterval(()=>{if(r.phase!=='answer'){stopTimer(r);return}r.remaining=Math.max(0,r.remaining-1);io.to(code).emit('timer',{remaining:r.remaining});if(r.remaining===0){stopTimer(r);for(const p of r.players.values())if(!p.locked){p.locked=true;p.answer=p.answer||''}r.phase='answerEnded';emitState(code);if(r.host)io.to(r.host).emit('timeUp')}},1000)}
function newQuestion(code){const r=rooms.get(code);if(!r)return;stopTimer(r);r.phase='answer';for(const p of r.players.values()){p.locked=false;p.answer=''}startTimer(code,true);io.to(code).emit('question',{number:r.current,total:r.questions.length,...currentQuestion(r)});emitState(code)}
function finalSummary(r){const rows=[...r.players.values()].map(p=>{let score=0;for(const g of r.results.values())if(g[p.token]==='correct')score++;return{id:p.id,name:p.name,group:p.group,score}});const gm={};for(const x of rows)gm[x.group]=(gm[x.group]||0)+x.score;return{rows:rows.sort((a,b)=>b.score-a.score),groups:Object.entries(gm).map(([group,score])=>({group,score})).sort((a,b)=>b.score-a.score)}}
function cleanupRoom(code){const r=rooms.get(code);if(!r)return;stopTimer(r);rooms.delete(code)}
function scheduleCleanup(code){const r=rooms.get(code);if(!r)return;r.cleanupAt=Date.now()+ROOM_TTL;setTimeout(()=>{const x=rooms.get(code);if(x&&x.cleanupAt<=Date.now())cleanupRoom(code)},ROOM_TTL+100)}

io.on('connection',s=>{
  s.on('authHost',d=>{const pw=String(d?.password||'');if(pw!==ADMIN_PASSWORD)return s.emit('authFailed',{role:'host',message:'パスワードが違います。'});const token=makeToken();adminTokens.add(token);s.data.adminToken=token;s.data.adminRole='host';s.emit('authOk',{role:'host',token})});
  s.on('authDisplay',d=>{const pw=String(d?.password||'');if(pw!==ADMIN_PASSWORD)return s.emit('authFailed',{role:'display',message:'パスワードが違います。'});s.data.adminRole='display';s.emit('authOk',{role:'display'})});
  s.on('create',d=>{if(s.data.adminRole!=='host')return s.emit('err','司会者ログインが必要です。');let code;do code=makeCode();while(rooms.has(code));const hostToken=makeToken();const setId=String(d?.setId||'');const selected=problemSets.find(x=>x.id===setId);const questions=selected?selected.questions.map(normalizeQuestion):[{text:'',image:''}];const r={host:s.id,hostToken,questions,current:1,phase:'setup',players:new Map(),results:new Map(),remaining:90,timer:null,cleanupAt:0};rooms.set(code,r);s.data.room=code;s.data.role='host';s.data.hostToken=hostToken;s.join(code);s.emit('created',{code,token:hostToken,setId:selected?.id||''});emitState(code)});
  s.on('resumeHost',d=>{if(s.data.adminRole!=='host')return s.emit('err','司会者ログインが必要です。');const code=String(d?.code||'').toUpperCase(),r=rooms.get(code);if(!r||r.hostToken!==d?.token)return s.emit('err','司会者の再接続情報が見つかりません。');r.host=s.id;s.data.room=code;s.data.role='host';s.data.hostToken=d.token;s.join(code);r.cleanupAt=0;emitState(code);if(r.phase==='answer'&&r.remaining>0)startTimer(code,false);s.emit('resumedHost')});
  s.on('joinDisplay',d=>{if(s.data.adminRole!=='display')return s.emit('displayError','プロジェクターログインが必要です。');const code=String(d?.roomCode||'').trim().toUpperCase(),r=rooms.get(code);if(!r)return s.emit('displayError','部屋がありません。');s.data.room=code;s.data.role='display';s.join(code);s.emit('displayJoined',{code});s.emit('state',statePayload(r))});
  s.on('join',d=>{const code=String(d?.code||'').trim().toUpperCase(),r=rooms.get(code);if(!r)return s.emit('err','部屋がありません。');if(r.players.size>=8)return s.emit('err','8人で満員です。');const token=makeToken();const p={id:s.id,token,name:String(d?.name||'PLAYER').slice(0,20),group:String(d?.group||'グループ').slice(0,20),locked:false,answer:'',connected:true};r.players.set(token,p);s.data.room=code;s.data.role='player';s.data.playerToken=token;s.join(code);s.emit('joined',{number:r.current,total:r.questions.length,...currentQuestion(r),token,phase:r.phase,locked:p.locked});emitState(code)});
  s.on('resumePlayer',d=>{const code=String(d?.code||'').toUpperCase(),r=rooms.get(code),p=r&&r.players.get(d?.token);if(!r||!p)return s.emit('err','参加情報が見つかりません。');p.id=s.id;p.connected=true;s.data.room=code;s.data.role='player';s.data.playerToken=d.token;s.join(code);r.cleanupAt=0;s.emit('resumedPlayer',{number:r.current,total:r.questions.length,...currentQuestion(r),locked:p.locked,phase:r.phase});emitState(code);if(r.phase==='reveal'){const result=r.results.get(r.current)?.[p.token];if(result)s.emit('myVerdict',{number:r.current,result})}});
  s.on('questions',qs=>{if(s.data.adminRole!=='host')return;const r=rooms.get(s.data.room);if(!r||r.host!==s.id||r.phase!=='setup')return;const a=Array.isArray(qs)?qs.map(normalizeQuestion).filter((q,i)=>i<20&&q.text.trim()):[];if(!a.length)return s.emit('err','1問以上入力してください。');r.questions=a;r.current=1;r.results=new Map();newQuestion(s.data.room)});
  s.on('lock',answer=>{const r=rooms.get(s.data.room),p=r&&r.players.get(s.data.playerToken);if(!r||!p||r.phase!=='answer'||p.locked)return;p.locked=true;p.answer=String(answer||'').slice(0,800000);emitState(s.data.room)});
  s.on('startGrading',()=>{if(s.data.adminRole!=='host')return;const r=rooms.get(s.data.room);if(!r||r.host!==s.id)return;if(!r.players.size||[...r.players.values()].some(p=>!p.locked))return s.emit('err','全員のLOCKを待ってください。');stopTimer(r);r.phase='grading';const rows=[...r.players.values()].map(p=>({id:p.id,name:p.name,group:p.group,answer:p.answer||''}));io.to(r.host).emit('grading',rows);io.to(s.data.room).emit('gradingStarted');emitState(s.data.room)});
  s.on('publishGrades',grades=>{if(s.data.adminRole!=='host')return;const r=rooms.get(s.data.room);if(!r||r.host!==s.id||r.phase!=='grading')return;const g={};for(const p of r.players.values()){if(!grades||!['correct','wrong'].includes(grades[p.id]))return s.emit('err','全員の〇×を決めてください。');g[p.token]=grades[p.id]}r.results.set(r.current,g);r.phase='reveal';const published=[...r.players.values()].map(p=>({id:p.id,name:p.name,group:p.group,answer:p.answer||'',result:g[p.token]}));io.to(r.host).emit('published',published);io.to(s.data.room).emit('revealPublished',published);for(const p of r.players.values())if(p.id)io.to(p.id).emit('myVerdict',{number:r.current,result:g[p.token]});emitState(s.data.room)});
  s.on('next',()=>{if(s.data.adminRole!=='host')return;const r=rooms.get(s.data.room);if(!r||r.host!==s.id||r.phase!=='reveal')return;if(r.current>=r.questions.length){r.phase='final';io.to(s.data.room).emit('final',finalSummary(r));emitState(s.data.room);return}r.current++;newQuestion(s.data.room)});
  s.on('reset',()=>{if(s.data.adminRole!=='host')return;const r=rooms.get(s.data.room);if(!r||r.host!==s.id)return;newQuestion(s.data.room)});
  s.on('disconnect',()=>{const code=s.data.room,r=code&&rooms.get(code);if(!r)return;if(r.host===s.id){r.host=null;io.to(code).emit('hostDisconnected');scheduleCleanup(code)}else if(s.data.role==='player'){const p=r.players.get(s.data.playerToken);if(p){p.connected=false;p.id=null}emitState(code);scheduleCleanup(code)}});
});
server.listen(process.env.PORT||3000,()=>console.log('OPEN QUIZ v7.3 running'));
