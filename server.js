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
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||'kashikoihito';
const adminTokens=new Set();
function isAdmin(req){return adminTokens.has(String(req.get('x-admin-token')||''))}
const DATA_DIR=path.join(__dirname,'data');
const SETS_FILE=path.join(DATA_DIR,'problem_sets.json');
const ADDITIONAL_FILE=path.join(DATA_DIR,'additional_problems.json');
if(!fs.existsSync(DATA_DIR))fs.mkdirSync(DATA_DIR,{recursive:true});
let problemSets=[];
try{problemSets=JSON.parse(fs.readFileSync(SETS_FILE,'utf8'));if(!Array.isArray(problemSets))problemSets=[]}catch(e){problemSets=[]}
let additionalProblems=[];
try{additionalProblems=JSON.parse(fs.readFileSync(ADDITIONAL_FILE,'utf8'));if(!Array.isArray(additionalProblems))additionalProblems=[]}catch(e){additionalProblems=[]}
let db=null;
let dbReady=Promise.resolve();
if(process.env.DATABASE_URL){
  const {Pool}=require('pg');
  db=new Pool({connectionString:process.env.DATABASE_URL,max:5,idleTimeoutMillis:30000,connectionTimeoutMillis:5000});
  dbReady=(async()=>{
    await db.query(`CREATE TABLE IF NOT EXISTS problem_sets (id TEXT PRIMARY KEY,name TEXT NOT NULL,questions JSONB NOT NULL,updated_at BIGINT NOT NULL)`);
    await db.query(`CREATE TABLE IF NOT EXISTS additional_problems (id TEXT PRIMARY KEY,text TEXT NOT NULL,image TEXT NOT NULL,updated_at BIGINT NOT NULL)`);
    const count=(await db.query('SELECT COUNT(*)::int AS n FROM problem_sets')).rows[0].n;
    if(count===0 && problemSets.length){
      for(const x of problemSets){await db.query('INSERT INTO problem_sets(id,name,questions,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING',[x.id,x.name,JSON.stringify(x.questions||[]),x.updatedAt||Date.now()])}
    }
    const acount=(await db.query('SELECT COUNT(*)::int AS n FROM additional_problems')).rows[0].n;
    if(acount===0 && additionalProblems.length){
      for(const x of additionalProblems){await db.query('INSERT INTO additional_problems(id,text,image,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING',[x.id,x.text,x.image||'',x.updatedAt||Date.now()])}
    }
  })().catch(e=>{console.error('DATABASE INIT ERROR',e);process.exit(1)});
}
function saveProblemSets(){fs.writeFileSync(SETS_FILE,JSON.stringify(problemSets,null,2),'utf8')}
function publicSet(x){return {id:x.id,name:x.name,questions:x.questions,updatedAt:x.updatedAt}}
async function getProblemSets(){
  await dbReady;
  if(!db)return problemSets;
  const rows=(await db.query('SELECT id,name,questions,updated_at FROM problem_sets ORDER BY updated_at ASC')).rows;
  return rows.map(r=>({id:r.id,name:r.name,questions:r.questions,updatedAt:Number(r.updated_at)}));
}
async function insertProblemSet(x){
  await dbReady;
  if(!db){problemSets.push(x);saveProblemSets();return x}
  await db.query('INSERT INTO problem_sets(id,name,questions,updated_at) VALUES($1,$2,$3,$4)',[x.id,x.name,JSON.stringify(x.questions),x.updatedAt]);
  return x;
}
async function updateProblemSet(id,name,questions){
  await dbReady;
  if(!db){const x=problemSets.find(v=>v.id===id);if(!x)return null;x.name=name;x.questions=questions;x.updatedAt=Date.now();saveProblemSets();return x}
  const r=await db.query('UPDATE problem_sets SET name=$1,questions=$2,updated_at=$3 WHERE id=$4 RETURNING id,name,questions,updated_at',[name,JSON.stringify(questions),Date.now(),id]);
  if(!r.rowCount)return null;const x=r.rows[0];return {id:x.id,name:x.name,questions:x.questions,updatedAt:Number(x.updated_at)};
}
async function deleteProblemSet(id){
  await dbReady;
  if(!db){const n=problemSets.length;problemSets=problemSets.filter(v=>v.id!==id);if(problemSets.length===n)return false;saveProblemSets();return true}
  return (await db.query('DELETE FROM problem_sets WHERE id=$1',[id])).rowCount>0;
}
async function getAdditionalProblems(){
  await dbReady;
  if(!db)return additionalProblems;
  const rows=(await db.query('SELECT id,text,image,updated_at FROM additional_problems ORDER BY updated_at ASC')).rows;
  return rows.map(r=>({id:r.id,text:r.text,image:r.image||'',updatedAt:Number(r.updated_at)}));
}
async function insertAdditionalProblem(x){
  await dbReady;
  if(!db){additionalProblems.push(x);fs.writeFileSync(ADDITIONAL_FILE,JSON.stringify(additionalProblems,null,2),'utf8');return x}
  await db.query('INSERT INTO additional_problems(id,text,image,updated_at) VALUES($1,$2,$3,$4)',[x.id,x.text,x.image||'',x.updatedAt]);
  return x;
}
async function updateAdditionalProblem(id,text,image){
  await dbReady;
  if(!db){const x=additionalProblems.find(v=>v.id===id);if(!x)return null;x.text=text;x.image=image||'';x.updatedAt=Date.now();fs.writeFileSync(ADDITIONAL_FILE,JSON.stringify(additionalProblems,null,2),'utf8');return x}
  const r=await db.query('UPDATE additional_problems SET text=$1,image=$2,updated_at=$3 WHERE id=$4 RETURNING id,text,image,updated_at',[text,image||'',Date.now(),id]);
  if(!r.rowCount)return null;const x=r.rows[0];return {id:x.id,text:x.text,image:x.image||'',updatedAt:Number(x.updated_at)};
}
async function deleteAdditionalProblem(id){
  await dbReady;
  if(!db){const n=additionalProblems.length;additionalProblems=additionalProblems.filter(v=>v.id!==id);if(additionalProblems.length===n)return false;fs.writeFileSync(ADDITIONAL_FILE,JSON.stringify(additionalProblems,null,2),'utf8');return true}
  return (await db.query('DELETE FROM additional_problems WHERE id=$1',[id])).rowCount>0;
}
function publicAdditional(x){return {id:x.id,text:x.text,image:x.image||'',updatedAt:x.updatedAt}}
const ROOM_TTL=30*60*1000;
app.use(express.json({limit:'20mb'}));
app.get('/api/problem-sets',async(req,res)=>{if(!isAdmin(req))return res.status(401).json({error:'司会者ログインが必要です。'});try{const sets=await getProblemSets();res.json(sets.map(publicSet))}catch(e){console.error(e);res.status(500).json({error:'問題集の読み込みに失敗しました。'})}});
app.post('/api/problem-sets',async(req,res)=>{if(!isAdmin(req))return res.status(401).json({error:'司会者ログインが必要です。'});const name=String(req.body?.name||'').trim().slice(0,60);const qs=Array.isArray(req.body?.questions)?req.body.questions.map(normalizeQuestion).filter(q=>q.text.trim()).slice(0,5):[];if(!name||qs.length!==5)return res.status(400).json({error:'セット名と5問が必要です。'});const x={id:crypto.randomBytes(8).toString('hex'),name,questions:qs,updatedAt:Date.now()};try{await insertProblemSet(x);res.json(publicSet(x))}catch(e){console.error(e);res.status(500).json({error:'問題集の保存に失敗しました。'})}});
app.put('/api/problem-sets/:id',async(req,res)=>{if(!isAdmin(req))return res.status(401).json({error:'司会者ログインが必要です。'});const name=String(req.body?.name||'').trim().slice(0,60);const qs=Array.isArray(req.body?.questions)?req.body.questions.map(normalizeQuestion).filter(q=>q.text.trim()).slice(0,5):[];if(!name||qs.length!==5)return res.status(400).json({error:'セット名と5問が必要です。'});try{const x=await updateProblemSet(req.params.id,name,qs);if(!x)return res.status(404).json({error:'セットが見つかりません。'});res.json(publicSet(x))}catch(e){console.error(e);res.status(500).json({error:'問題集の更新に失敗しました。'})}});
app.delete('/api/problem-sets/:id',async(req,res)=>{if(!isAdmin(req))return res.status(401).json({error:'司会者ログインが必要です。'});try{if(!await deleteProblemSet(req.params.id))return res.status(404).json({error:'セットが見つかりません。'});res.json({ok:true})}catch(e){console.error(e);res.status(500).json({error:'問題集の削除に失敗しました。'})}});
app.post('/api/problem-sets/import',async(req,res)=>{
  if(!isAdmin(req))return res.status(401).json({error:'司会者ログインが必要です。'});
  try{
    const incoming=Array.isArray(req.body?.sets)?req.body.sets:[];
    if(!incoming.length)return res.json({ok:true,imported:0});
    const existing=await getProblemSets();
    const ids=new Set(existing.map(x=>x.id));
    let imported=0;
    for(const raw of incoming){
      const id=String(raw?.id||'');
      const name=String(raw?.name||'').trim().slice(0,60);
      const qs=Array.isArray(raw?.questions)?raw.questions.map(normalizeQuestion).filter(q=>q.text.trim()).slice(0,5):[];
      if(!id||!name||qs.length!==5||ids.has(id))continue;
      await insertProblemSet({id,name,questions:qs,updatedAt:Number(raw?.updatedAt)||Date.now()});
      ids.add(id);imported++;
    }
    res.json({ok:true,imported});
  }catch(e){console.error(e);res.status(500).json({error:'問題集の移行に失敗しました。'})}
});
app.get('/api/additional-problems',async(req,res)=>{if(!isAdmin(req))return res.status(401).json({error:'司会者ログインが必要です。'});try{const xs=await getAdditionalProblems();res.json(xs.map(publicAdditional))}catch(e){console.error(e);res.status(500).json({error:'追加問題の読み込みに失敗しました。'})}});
app.post('/api/additional-problems',async(req,res)=>{if(!isAdmin(req))return res.status(401).json({error:'司会者ログインが必要です。'});const text=String(req.body?.text||'').trim().slice(0,300);const image=typeof req.body?.image==='string'?req.body.image:'';if(!text)return res.status(400).json({error:'問題文を入力してください。'});const x={id:crypto.randomBytes(8).toString('hex'),text,image,updatedAt:Date.now()};try{await insertAdditionalProblem(x);res.json(publicAdditional(x))}catch(e){console.error(e);res.status(500).json({error:'追加問題の保存に失敗しました。'})}});
app.put('/api/additional-problems/:id',async(req,res)=>{if(!isAdmin(req))return res.status(401).json({error:'司会者ログインが必要です。'});const text=String(req.body?.text||'').trim().slice(0,300);const image=typeof req.body?.image==='string'?req.body.image:'';if(!text)return res.status(400).json({error:'問題文を入力してください。'});try{const x=await updateAdditionalProblem(req.params.id,text,image);if(!x)return res.status(404).json({error:'追加問題が見つかりません。'});res.json(publicAdditional(x))}catch(e){console.error(e);res.status(500).json({error:'追加問題の更新に失敗しました。'})}});
app.delete('/api/additional-problems/:id',async(req,res)=>{if(!isAdmin(req))return res.status(401).json({error:'司会者ログインが必要です。'});try{if(!await deleteAdditionalProblem(req.params.id))return res.status(404).json({error:'追加問題が見つかりません。'});res.json({ok:true})}catch(e){console.error(e);res.status(500).json({error:'追加問題の削除に失敗しました。'})}});
app.post('/api/additional-problems/import',async(req,res)=>{if(!isAdmin(req))return res.status(401).json({error:'司会者ログインが必要です。'});try{const incoming=Array.isArray(req.body?.problems)?req.body.problems:[];if(!incoming.length)return res.json({ok:true,imported:0});const existing=await getAdditionalProblems();const ids=new Set(existing.map(x=>x.id));let imported=0;for(const raw of incoming){const id=String(raw?.id||'');const text=String(raw?.text||'').trim().slice(0,300);const image=typeof raw?.image==='string'?raw.image:'';if(!id||!text||ids.has(id))continue;await insertAdditionalProblem({id,text,image,updatedAt:Number(raw?.updatedAt)||Date.now()});ids.add(id);imported++}res.json({ok:true,imported})}catch(e){console.error(e);res.status(500).json({error:'追加問題の移行に失敗しました。'})}});
app.use(express.static(path.join(__dirname,'public')));
app.get('/display',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
const makeCode=()=>crypto.randomBytes(3).toString('hex').toUpperCase();
const makeToken=()=>crypto.randomBytes(18).toString('hex');
const normalizeQuestion=q=>typeof q==='string'?{text:String(q).slice(0,300),image:''}:{text:String(q?.text||'').slice(0,300),image:typeof q?.image==='string'?q.image:''};
function currentQuestion(r){return r.questions[r.current-1]||{text:'',image:''}}
function publicPlayers(r){return [...r.players.values()].map(p=>({id:p.id,name:p.name,locked:p.locked,connected:p.connected!==false}))}
function statePayload(r){
  const payload={question:currentQuestion(r),current:r.current,total:r.questions.length,phase:r.phase,remaining:r.remaining,players:publicPlayers(r)};
  if(r.phase==='reveal'){
    const g=r.results.get(r.current)||{};
    payload.published=[...r.players.values()].map(p=>({id:p.id,name:p.name,answer:p.answer||'',result:g[p.token]}));
  }
  if(r.phase==='final') payload.final=finalSummary(r);
  return payload;
}
function emitState(code){const r=rooms.get(code);if(r)io.to(code).emit('state',statePayload(r));}
function stopTimer(r){if(r.timer){clearInterval(r.timer);r.timer=null}}
function startTimer(code,reset=true){const r=rooms.get(code);if(!r)return;stopTimer(r);if(reset)r.remaining=75;emitState(code);r.timer=setInterval(()=>{if(r.phase!=='answer'){stopTimer(r);return}r.remaining=Math.max(0,r.remaining-1);io.to(code).emit('timer',{remaining:r.remaining});if(r.remaining===0){stopTimer(r);for(const p of r.players.values())if(!p.locked){p.locked=true;p.answer=p.answer||''}r.phase='answerEnded';emitState(code);if(r.host)io.to(r.host).emit('timeUp')}},1000)}
function newQuestion(code){const r=rooms.get(code);if(!r)return;stopTimer(r);r.phase='answer';for(const p of r.players.values()){p.locked=false;p.answer=''}startTimer(code,true);io.to(code).emit('question',{number:r.current,total:r.questions.length,...currentQuestion(r)});emitState(code)}
function finalSummary(r){const rows=[...r.players.values()].map(p=>{let score=0;for(const g of r.results.values())if(g[p.token]==='correct')score++;return{id:p.id,name:p.name,score}});return{rows:rows.sort((a,b)=>b.score-a.score)}}
function cleanupRoom(code){const r=rooms.get(code);if(!r)return;stopTimer(r);rooms.delete(code)}
function scheduleCleanup(code){const r=rooms.get(code);if(!r)return;r.cleanupAt=Date.now()+ROOM_TTL;setTimeout(()=>{const x=rooms.get(code);if(x&&x.cleanupAt<=Date.now())cleanupRoom(code)},ROOM_TTL+100)}

io.on('connection',s=>{
  s.on('authHost',d=>{const pw=String(d?.password||'');if(pw!==ADMIN_PASSWORD)return s.emit('authFailed',{role:'host',message:'パスワードが違います。'});const token=makeToken();adminTokens.add(token);s.data.adminToken=token;s.data.adminRole='host';s.emit('authOk',{role:'host',token})});
  s.on('authDisplay',d=>{const pw=String(d?.password||'');if(pw!==ADMIN_PASSWORD)return s.emit('authFailed',{role:'display',message:'パスワードが違います。'});s.data.adminRole='display';s.emit('authOk',{role:'display'})});
  s.on('create',async d=>{if(s.data.adminRole!=='host')return s.emit('err','司会者ログインが必要です。');let code;do code=makeCode();while(rooms.has(code));const hostToken=makeToken();const setId=String(d?.setId||'');let selected=null;try{selected=(await getProblemSets()).find(x=>x.id===setId)||null}catch(e){return s.emit('err','問題集の読み込みに失敗しました。')}const questions=selected?selected.questions.map(normalizeQuestion):[{text:'',image:''}];const r={host:s.id,hostToken,questions,current:1,baseTotal:questions.length,phase:'setup',players:new Map(),results:new Map(),remaining:75,timer:null,cleanupAt:0};rooms.set(code,r);s.data.room=code;s.data.role='host';s.data.hostToken=hostToken;s.join(code);s.emit('created',{code,token:hostToken,setId:selected?.id||''});emitState(code)});
  s.on('resumeHost',d=>{if(s.data.adminRole!=='host')return s.emit('err','司会者ログインが必要です。');const code=String(d?.code||'').toUpperCase(),r=rooms.get(code);if(!r||r.hostToken!==d?.token)return s.emit('err','司会者の再接続情報が見つかりません。');r.host=s.id;s.data.room=code;s.data.role='host';s.data.hostToken=d.token;s.join(code);r.cleanupAt=0;emitState(code);if(r.phase==='answer'&&r.remaining>0)startTimer(code,false);s.emit('resumedHost')});
  s.on('joinDisplay',d=>{if(s.data.adminRole!=='display')return s.emit('displayError','プロジェクターログインが必要です。');const code=String(d?.roomCode||'').trim().toUpperCase(),r=rooms.get(code);if(!r)return s.emit('displayError','部屋がありません。');s.data.room=code;s.data.role='display';s.join(code);s.emit('displayJoined',{code});s.emit('state',statePayload(r))});
  s.on('join',d=>{const code=String(d?.code||'').trim().toUpperCase(),r=rooms.get(code);if(!r)return s.emit('err','部屋がありません。');if(r.players.size>=8)return s.emit('err','8人で満員です。');const token=makeToken();const p={id:s.id,token,name:String(d?.name||'PLAYER').slice(0,20),locked:false,answer:'',connected:true};r.players.set(token,p);s.data.room=code;s.data.role='player';s.data.playerToken=token;s.join(code);s.emit('joined',{number:r.current,total:r.questions.length,...(r.phase==='setup'?{text:'',image:''}:currentQuestion(r)),token,phase:r.phase,locked:p.locked});emitState(code)});
  s.on('resumePlayer',d=>{const code=String(d?.code||'').toUpperCase(),r=rooms.get(code),p=r&&r.players.get(d?.token);if(!r||!p)return s.emit('err','参加情報が見つかりません。');p.id=s.id;p.connected=true;s.data.room=code;s.data.role='player';s.data.playerToken=d.token;s.join(code);r.cleanupAt=0;s.emit('resumedPlayer',{number:r.current,total:r.questions.length,...(r.phase==='setup'?{text:'',image:''}:currentQuestion(r)),locked:p.locked,phase:r.phase});emitState(code);if(r.phase==='reveal'){const result=r.results.get(r.current)?.[p.token];if(result)s.emit('myVerdict',{number:r.current,result})}});
  s.on('questions',qs=>{if(s.data.adminRole!=='host')return;const r=rooms.get(s.data.room);if(!r||r.host!==s.id||r.phase!=='setup')return;const a=Array.isArray(qs)?qs.map(normalizeQuestion).filter((q,i)=>i<20&&q.text.trim()):[];if(!a.length)return s.emit('err','1問以上入力してください。');r.questions=a;r.current=1;r.results=new Map();newQuestion(s.data.room)});
  s.on('lock',answer=>{const r=rooms.get(s.data.room),p=r&&r.players.get(s.data.playerToken);if(!r||!p||r.phase!=='answer'||p.locked)return;p.locked=true;p.answer=String(answer||'').slice(0,800000);emitState(s.data.room)});
  s.on('startGrading',()=>{if(s.data.adminRole!=='host')return;const r=rooms.get(s.data.room);if(!r||r.host!==s.id)return;if(!r.players.size||[...r.players.values()].some(p=>!p.locked))return s.emit('err','全員のLOCKを待ってください。');stopTimer(r);r.phase='grading';const rows=[...r.players.values()].map(p=>({id:p.id,name:p.name,answer:p.answer||''}));io.to(r.host).emit('grading',rows);io.to(s.data.room).emit('gradingStarted');emitState(s.data.room)});
  s.on('publishGrades',grades=>{if(s.data.adminRole!=='host')return;const r=rooms.get(s.data.room);if(!r||r.host!==s.id||r.phase!=='grading')return;const g={};for(const p of r.players.values()){if(!grades||!['correct','wrong'].includes(grades[p.id]))return s.emit('err','全員の〇×を決めてください。');g[p.token]=grades[p.id]}r.results.set(r.current,g);r.phase='reveal';const published=[...r.players.values()].map(p=>({id:p.id,name:p.name,answer:p.answer||'',result:g[p.token]}));io.to(r.host).emit('published',published);io.to(s.data.room).emit('revealPublished',published);for(const p of r.players.values())if(p.id)io.to(p.id).emit('myVerdict',{number:r.current,result:g[p.token]});emitState(s.data.room)});
  s.on('addAdditionalQuestion',async d=>{if(s.data.adminRole!=='host')return;const r=rooms.get(s.data.room);if(!r||r.host!==s.id||r.phase!=='reveal')return;if(r.current!==r.questions.length)return s.emit('err','追加問題は5問セット終了後に選べます。');const id=String(d?.id||'');try{const x=(await getAdditionalProblems()).find(v=>v.id===id);if(!x)return s.emit('err','追加問題が見つかりません。');r.questions.push(normalizeQuestion(x));r.current=r.questions.length;newQuestion(s.data.room)}catch(e){console.error(e);s.emit('err','追加問題の読み込みに失敗しました。')}});
  s.on('endRoom',()=>{if(s.data.adminRole!=='host')return;const r=rooms.get(s.data.room);if(!r||r.host!==s.id)return;const roomCode=s.data.room;io.to(roomCode).emit('displayReset');io.to(roomCode).emit('roomEnded');cleanupRoom(roomCode);});
  s.on('next',()=>{if(s.data.adminRole!=='host')return;const r=rooms.get(s.data.room);if(!r||r.host!==s.id||r.phase!=='reveal')return;if(r.current>=r.questions.length){r.phase='final';io.to(s.data.room).emit('final',finalSummary(r));emitState(s.data.room);return}r.current++;newQuestion(s.data.room)});
  s.on('reset',()=>{if(s.data.adminRole!=='host')return;const r=rooms.get(s.data.room);if(!r||r.host!==s.id)return;newQuestion(s.data.room)});
  s.on('disconnect',()=>{const code=s.data.room,r=code&&rooms.get(code);if(!r)return;if(r.host===s.id){r.host=null;io.to(code).emit('hostDisconnected');scheduleCleanup(code)}else if(s.data.role==='player'){const p=r.players.get(s.data.playerToken);if(p){p.connected=false;p.id=null}emitState(code);scheduleCleanup(code)}});
});
server.listen(process.env.PORT||3000,()=>console.log('OPEN QUIZ v7.10 running'));
