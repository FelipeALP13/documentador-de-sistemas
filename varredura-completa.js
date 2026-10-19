const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {chromium}=require('playwright');
const ui=require('./crawler-interface');
const {waitForInterface}=require('./crawler-ui-state');
const {walkMenus}=require('./crawler-navigation');
const {exploreContent,pageSignature}=require('./crawler-content');
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
 let browser,context,page,network,readOnly=false,authNavigation=null,allowAuthReplay=false,authenticatedUrl='',readActionDepth=0;
 let menu=[];
 const withReadAction=async action=>{
  readActionDepth++;
  try{return await action()}finally{readActionDepth--}
 };
 const pageShowsLabel=async label=>{
  const expected=String(label||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim().toLowerCase();
  for(const frame of page.frames()){
   const found=await frame.locator('h1:visible,h2:visible,[aria-current="page"]:visible,.breadcrumb .active:visible').evaluateAll((elements,value)=>elements.some(element=>(element.innerText||element.textContent||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim().toLowerCase()===value),expected).catch(()=>false);
   if(found)return true;
  }
  return false;
 };
 const interfaceOptions={timeout:options.interfaceTimeoutMs||30000,allowBlocked:true,failureCheck:()=>network?.failure(),onNotice:message=>{notices.push({message});log(message)}};
 const handleRequest=route=>{
  const settle=promise=>promise.catch(error=>{if(!/Route is already handled/i.test(error.message))throw error});
  const request=route.request(),method=request.method().toUpperCase();
  if(!readOnly&&request.isNavigationRequest()&&method==='POST')authNavigation={method,url:request.url()};
  const description=`${request.url()} ${request.postData()||''}`;
  const destructiveNavigation=/(?:^|[\/_?&=.-])(delete|remove|destroy|save|update|submit|approve|reject|publish|payment|pay|cancel|confirm|finalize|logout|signout|excluir|remover|salvar|gravar|atualizar|enviar|submeter|aprovar|reprovar|publicar|pagar|cancelar|confirmar|finalizar|encerrar|sair)(?:$|[\/_?&=.-])/i.test(description);
  const authReplay=allowAuthReplay&&authNavigation&&method===authNavigation.method&&request.url()===authNavigation.url;
  const mutationMethod=!['GET','HEAD','OPTIONS'].includes(method);
  // Several JSP systems load a consultation screen through POST/XHR. Permit a
  // neutral POST only while the crawler is activating a control that it has
  // already classified as safe. Background writes remain blocked, as do all
  // requests whose URL or payload describes a destructive action.
  const scopedReadPost=readActionDepth>0&&method==='POST'&&!destructiveNavigation;
  const blocked=['PUT','PATCH','DELETE'].includes(method)||(readOnly&&!authReplay&&((mutationMethod&&!scopedReadPost)||destructiveNavigation));
  if(blocked){notices.push({message:'Uma tentativa de alteração foi bloqueada pelo modo somente leitura.'});return settle(route.abort('aborted'))}
  return settle(route.continue());
 };
 const createContextPage=async()=>{
  context=await browser.newContext({viewport:{width:1280,height:900},deviceScaleFactor:1,serviceWorkers:'block'});
  await context.route('**/*',handleRequest);
  page=await context.newPage();page.setDefaultTimeout(5000);
  page.on('dialog',dialog=>dialog.dismiss().catch(()=>{}));
 };
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
  await createContextPage();
  await page.goto(env.SISTEMA_URL,{waitUntil:'domcontentloaded',timeout:45000});
  menu=await ui.login(page,env,options.loginTimeoutMs||30000);
  authenticatedUrl=page.url().split('#')[0];
  readOnly=true;
  network=attachNetworkMonitor(page,url=>ui.safeUrl(url,redact),message=>{
   const warning={label:'interface',error:redact(message),code:'PAGE_SCRIPT_ERROR'};
   warnings.push(warning);log(`Aviso: ${warning.error}`);
  });
  const resumeCurrent=async()=>{
   if(await ui.findLogin(page,{strict:true})){
    const message='A sessão expirou; autenticando novamente para continuar.';
    notices.push({message});log(message);readOnly=false;
    try{menu=await ui.login(page,env,options.loginTimeoutMs||30000);authenticatedUrl=page.url().split('#')[0]}finally{readOnly=true}
    network.reset('recuperação da sessão');
   }
   const discovered=await ui.discoverMenus(page);
   const available=discovered.some(item=>!item.virtual)||discovered.some(item=>item.virtual)&&page.url().split('#')[0]===authenticatedUrl;
   if(!available)return false;
   await waitForInterface(page,interfaceOptions);
   return true;
  };
  const recover=async()=>{
   network?.reset('recuperação');
   if(await resumeCurrent().catch(()=>false)){log('Continuando pela interface autenticada atual.');return}
   log('Retornando pelo histórico para continuar a varredura.');
   for(let attempt=0;attempt<4;attempt++){
    allowAuthReplay=true;
    const response=await page.goBack({waitUntil:'domcontentloaded',timeout:15000}).catch(()=>null).finally(()=>{allowAuthReplay=false});
    network?.reset('recuperação pelo histórico');
    if(await resumeCurrent().catch(()=>false))return;
    if(!response)break;
   }
   log('Recuperando pela URL de acesso para continuar a varredura.');
   let response=await page.goto(env.SISTEMA_URL,{waitUntil:'domcontentloaded',timeout:30000});
   network?.reset('recuperação pela URL de acesso');
   if((!response||response.status()<400)&&await resumeCurrent().catch(()=>false))return;
   log('Reiniciando a sessão temporária para recuperar a interface.');
   network?.dispose();network=null;
   await browser.close();
   browser=await chromium.launch({headless:true,channel:options.browserChannel||process.env.DOCUMENTADOR_BROWSER_CHANNEL||'msedge'});
   authNavigation=null;allowAuthReplay=false;
   await createContextPage();
   readOnly=false;
   try{
    response=await page.goto(env.SISTEMA_URL,{waitUntil:'domcontentloaded',timeout:30000});
    if(response&&response.status()>=400)throw Object.assign(new Error(`O servidor retornou HTTP ${response.status()} ao abrir ${ui.safeUrl(response.url(),redact)}.`),{code:`HTTP_${response.status()}`});
    menu=await ui.login(page,env,options.loginTimeoutMs||30000);
    authenticatedUrl=page.url().split('#')[0];
   }finally{readOnly=true}
   network=attachNetworkMonitor(page,url=>ui.safeUrl(url,redact),message=>{
    const warning={label:'interface',error:redact(message),code:'PAGE_SCRIPT_ERROR'};
    warnings.push(warning);log(`Aviso: ${warning.error}`);
   });
   network.reset('recuperação por nova sessão');
   if(!(await resumeCurrent()))throw new Error('A interface autenticada não ficou disponível durante a recuperação.');
  };
  flush(menu);log('Menus encontrados:',menu.length);
  async function capture(parts,kind,targetPage=page){
   const label=parts.join(' > ');
   await waitForInterface(targetPage,{...interfaceOptions,failureCheck:targetPage===page?interfaceOptions.failureCheck:undefined,allowForms:true});
   let bytes;
   for(let attempt=0;attempt<3&&!bytes;attempt++){
    try{bytes=await targetPage.screenshot({type:'jpeg',quality:84,fullPage:false,timeout:15000})}
    catch(error){if(attempt===2)throw error;await targetPage.waitForTimeout(350)}
   }
   const sha=crypto.createHash('sha256').update(bytes).digest('hex');
   const duplicate=hashes.get(sha);
   const rel=path.join(...parts.slice(0,2).map(p=>slug(redact(p))),`${kind}${parts.length>2?'_'+slug(redact(parts.slice(2).join('_'))):''}_${records.length+1}.jpg`);
   if(!duplicate){const dest=path.join(out,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,bytes);hashes.set(sha,rel)}
   const metadata=[];
   for(const frame of targetPage.frames()){
    if(frame.isDetached())continue;
    metadata.push(await frame.evaluate(()=>({text:(document.querySelector('main')||document.body)?.innerText||'',heading:[...document.querySelectorAll('h1,h2')].map(e=>e.textContent),tabs:[...document.querySelectorAll('[role="tab"]')].map(e=>e.textContent),buttons:[...document.querySelectorAll('button,input[type="submit"]')].map(e=>e.textContent||e.getAttribute('aria-label')||'')})).catch(()=>({text:'',heading:[],tabs:[],buttons:[]})));
   }
   records.push({label,kind,image:duplicate||rel,duplicateOf:duplicate||null,heading:metadata.flatMap(m=>m.heading).slice(0,10),tabs:metadata.flatMap(m=>m.tabs),buttons:metadata.flatMap(m=>m.buttons).map(s=>s.trim()).filter(Boolean).slice(0,30),text:redact(metadata.map(m=>m.text).join('\n').slice(0,20000)),sha256:sha});
   flush(menu);log(redact(`[${records.length}] ${label}${duplicate?' [igual a '+duplicate+']':''}`));
  }
  traversal=await walkMenus(page,menu,{
   maxMenus:options.maxMenus||1000,
   open:async entry=>withReadAction(async()=>{
    const label=[...entry.parentNames||[],entry.name].join(' > '),before=await pageSignature(page),alreadyVisible=await pageShowsLabel(entry.name);
    const frame=ui.resolveFrame(page,entry.framePath);
    const href=String(entry.href||'').trim();
    const alreadyAtTarget=!!frame&&href&&!/^(?:#|javascript:|mailto:|tel:)/i.test(href)&&new URL(href,frame.url()).href.split('#')[0]===frame.url().split('#')[0];
    network.reset(label);await ui.openMenu(page,entry,interfaceOptions);
    if(await ui.findLogin(page,{strict:true}))throw Object.assign(new Error('A sessão retornou à tela de login.'),{code:'SESSION_EXPIRED'});
    return {changed:alreadyVisible||alreadyAtTarget||(await pageSignature(page))!==before};
   }),
   recover,report,onQueue:()=>flush(menu),onWarning:message=>{warnings.push(message);log(message)},
   onRetry:entry=>{const message=redact(`Nova tentativa de navegação: ${[...entry.parentNames||[],entry.name].join(' > ')}`);notices.push({message});log(message)},
   visit:async entry=>{
    const parts=entry.parentNames?.length?[...entry.parentNames,entry.name]:[entry.name];
    await capture(parts,'geral');
    await exploreContent(page,parts,{capture,report,interfaceOptions,runReadAction:withReadAction,onAction:label=>network.reset(label),isKnownScreen:name=>menu.some(item=>item.name===name),restore:async()=>{
     const findCurrent=async()=>(await ui.discoverMenus(page)).find(item=>item.name===entry.name&&JSON.stringify(item.parentNames)===JSON.stringify(entry.parentNames)&&JSON.stringify(item.framePath)===JSON.stringify(entry.framePath)&&(!entry.virtual||page.url().split('#')[0]===authenticatedUrl));
     network.reset(`retorno para ${parts.join(' > ')}`);
     let current=await findCurrent();
     if(current||!entry.virtual){try{await withReadAction(()=>ui.openMenu(page,current||entry,interfaceOptions));return}catch{}}
     await recover();
     current=await findCurrent();
     if(!current&&entry.virtual)throw Object.assign(new Error('Não foi possível retornar à tela após abrir o formulário.'),{code:'RESTORE_FAILED',recoverable:true});
     try{await withReadAction(()=>ui.openMenu(page,current||entry,interfaceOptions))}catch{throw Object.assign(new Error('Não foi possível retornar à tela após abrir o formulário.'),{code:'RESTORE_FAILED',recoverable:true})}
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
