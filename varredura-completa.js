const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {chromium}=require('playwright');
const ui=require('./crawler-interface');
const {waitForInterface}=require('./crawler-ui-state');
const {walkMenus}=require('./crawler-navigation');
const {exploreContent}=require('./crawler-content');
const {attachNetworkMonitor}=require('./crawler-network');
function slug(s){return s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/gi,'_').replace(/^_|_$/g,'').slice(0,65)||'sem_nome'}
async function main(options={}){
 const env=options.credentials||require('dotenv').parse(fs.readFileSync(path.join(__dirname,'.env')));
 const root=options.artifactsRoot||path.join(__dirname,'artifacts');
 const run=new Date().toISOString().replace(/[:.]/g,'-');
 const out=path.join(root,run);
 const records=[];const errors=[];const hashes=new Map();
 const warnings=[];const notices=[];
 let status='running',traversal=null;
 const log=options.log||console.log;
 const secrets=[env.SISTEMA_USER,env.SISTEMA_PASS];
 const redact=ui.redactor(secrets);
 function flush(menu){fs.writeFileSync(path.join(out,'scan-manifest.json'),JSON.stringify({run,startedAt:run,finishedAt:status==='running'?null:new Date().toISOString(),status,traversal,menu:menu.map(m=>({name:m.name,framePath:m.framePath})),records,errors,warnings,notices},(key,value)=>['image','duplicateOf','diagnostic','sha256','run','startedAt','finishedAt'].includes(key)?value:typeof value==='string'?redact(value):value,2))}
 fs.mkdirSync(out,{recursive:true});
 let browser,page,network,readOnly=false;
 let menu=[];
 const interfaceOptions={timeout:options.interfaceTimeoutMs||30000,failureCheck:()=>network?.failure(),onNotice:message=>{notices.push({message});log(message)}};
 async function report(label,e){
  const file=await ui.writeDiagnostic(page,out,e,secrets,env.SISTEMA_URL);
  const recoverable=!!e.recoverable||/^HTTP_(?:\d+|5XX)$/.test(e.code||'')||e.code==='NETWORK_FAILURE';
  const item={label:redact(label),error:redact(e.message.split('\n')[0]).replace(/https?:\/\/[^\s"']+/g,u=>ui.safeUrl(u,redact)),diagnostic:path.basename(file),code:e.code||null};
  (recoverable?warnings:errors).push(item);
  flush(menu);log(`${recoverable?'Aviso':'Falha'} em ${item.label}: ${item.error}`);log('Diagnóstico:',file);
  return {recoverable};
 }
 try{
  browser=await chromium.launch({headless:true,channel:options.browserChannel||process.env.DOCUMENTADOR_BROWSER_CHANNEL||'msedge'});
  const context=await browser.newContext({viewport:{width:1280,height:900},deviceScaleFactor:1});
  await context.route('**/*',route=>{
   const request=route.request(),method=request.method().toUpperCase();
   const description=`${request.url()} ${request.postData()||''}`;
   const unsafeMutation=/(?:^|[\/_?&=.-])(delete|remove|destroy|save|update|create|submit|approve|reject|publish|payment|pay|cancel|logout|signout)(?:$|[\/_?&=.-])/i.test(description);
   const destructiveNavigation=/(?:^|[\/_?&=.-])(delete|remove|destroy|approve|reject|publish|payment|pay|cancel|logout|signout)(?:$|[\/_?&=.-])/i.test(request.url());
   const blocked=['PUT','PATCH','DELETE'].includes(method)||(readOnly&&((method==='POST'&&request.isNavigationRequest())||(method!=='GET'&&method!=='HEAD'&&unsafeMutation)||(method==='GET'&&destructiveNavigation)));
   if(blocked){notices.push({message:'Uma tentativa de alteração foi bloqueada pelo modo somente leitura.'});return route.abort()}
   return route.continue();
  });
  page=await context.newPage();page.setDefaultTimeout(5000);
  page.on('dialog',dialog=>dialog.dismiss().catch(()=>{}));
  await page.goto(env.SISTEMA_URL,{waitUntil:'domcontentloaded',timeout:45000});
  menu=await ui.login(page,env,options.loginTimeoutMs||30000);
  readOnly=true;
  network=attachNetworkMonitor(page,url=>ui.safeUrl(url,redact),message=>{
   const warning={label:'interface',error:redact(message),code:'PAGE_SCRIPT_ERROR'};
   warnings.push(warning);log(`Aviso: ${warning.error}`);
  });
  const recover=async()=>{
   network.reset();
   log('Recuperando pela URL de acesso para continuar a varredura.');
   await page.goto(env.SISTEMA_URL,{waitUntil:'domcontentloaded',timeout:30000});
   await waitForInterface(page,interfaceOptions);
   if(await ui.findLogin(page,{strict:true})){
    const message='A sessão expirou; autenticando novamente para continuar.';
    notices.push({message});log(message);readOnly=false;
    try{menu=await ui.login(page,env,options.loginTimeoutMs||30000)}finally{readOnly=true}
    network.reset('recuperação da sessão');
   }
  };
  flush(menu);log('Menus encontrados:',menu.length);
  async function capture(parts,kind){
   await waitForInterface(page,{...interfaceOptions,allowForms:true});
   const label=parts.join(' > ');
   let bytes;
   for(let attempt=0;attempt<3&&!bytes;attempt++){
    try{bytes=await page.screenshot({type:'jpeg',quality:84,fullPage:false,timeout:15000})}
    catch(error){if(attempt===2)throw error;await page.waitForTimeout(350)}
   }
   const sha=crypto.createHash('sha256').update(bytes).digest('hex');
   const duplicate=hashes.get(sha);
   const rel=path.join(...parts.slice(0,2).map(p=>slug(redact(p))),`${kind}${parts.length>2?'_'+slug(redact(parts.slice(2).join('_'))):''}_${records.length+1}.jpg`);
   if(!duplicate){const dest=path.join(out,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,bytes);hashes.set(sha,rel)}
   const metadata=[];
   for(const frame of page.frames()){
    if(frame.isDetached())continue;
    metadata.push(await frame.evaluate(()=>({text:(document.querySelector('main')||document.body)?.innerText||'',heading:[...document.querySelectorAll('h1,h2')].map(e=>e.textContent),tabs:[...document.querySelectorAll('[role="tab"]')].map(e=>e.textContent),buttons:[...document.querySelectorAll('button,input[type="submit"]')].map(e=>e.textContent||e.getAttribute('aria-label')||'')})).catch(()=>({text:'',heading:[],tabs:[],buttons:[]})));
   }
   records.push({label,kind,image:duplicate||rel,duplicateOf:duplicate||null,heading:metadata.flatMap(m=>m.heading).slice(0,10),tabs:metadata.flatMap(m=>m.tabs),buttons:metadata.flatMap(m=>m.buttons).map(s=>s.trim()).filter(Boolean).slice(0,30),text:redact(metadata.map(m=>m.text).join('\n').slice(0,20000)),sha256:sha});
   flush(menu);log(redact(`[${records.length}] ${label}${duplicate?' [igual a '+duplicate+']':''}`));
  }
  traversal=await walkMenus(page,menu,{
   maxMenus:options.maxMenus||1000,
   open:async entry=>{const label=[...entry.parentNames||[],entry.name].join(' > ');network.reset(label);await ui.openMenu(page,entry,interfaceOptions);if(await ui.findLogin(page,{strict:true}))throw Object.assign(new Error('A sessão retornou à tela de login.'),{code:'SESSION_EXPIRED'});},
   recover,report,onQueue:()=>flush(menu),onWarning:message=>{warnings.push(message);log(message)},
   onRetry:entry=>{const message=redact(`Nova tentativa de navegação: ${[...entry.parentNames||[],entry.name].join(' > ')}`);notices.push({message});log(message)},
   visit:async entry=>{
    const parts=entry.parentNames?.length?[...entry.parentNames,entry.name]:[entry.name];
    await capture(parts,'geral');
    await exploreContent(page,parts,{capture,report,interfaceOptions,onAction:label=>network.reset(label),restore:async()=>{
     await recover();
     const current=(await ui.discoverMenus(page)).find(item=>item.name===entry.name&&JSON.stringify(item.parentNames)===JSON.stringify(entry.parentNames)&&JSON.stringify(item.framePath)===JSON.stringify(entry.framePath));
     if(!current)throw new Error('Não foi possível retornar à tela após abrir o formulário.');
     await ui.openMenu(page,current,interfaceOptions);
    }});
   }
  });
  if(!traversal.visited)throw new Error('Nenhum menu pôde ser capturado. Consulte os diagnósticos da execução.');
  status=traversal.complete&&!errors.length?'complete':'partial';
 }catch(e){status='failed';await report('execução',e);throw new Error(`${errors.at(-1).error} Diagnóstico em: ${out}`);}
 finally{flush(menu);await browser?.close();log(status==='complete'?'Concluído:':status==='partial'?'Varredura parcial:':'Falha:',out,'capturas:',new Set(records.map(r=>r.image)).size,'erros:',errors.length,'avisos:',warnings.length)}
 return {out,run,status,complete:status==='complete',records:records.length,errors:errors.length,pending:traversal?.pending.length||0,warnings};
}
if(require.main===module)main().catch(e=>{console.error('Falha:',e.message);process.exitCode=1});
module.exports={main,slug};
