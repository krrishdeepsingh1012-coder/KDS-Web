(() => {
 const $ = s => document.querySelector(s);
 const api = async (url, options={}) => {
   const r = await fetch(url,{credentials:'same-origin',...options,headers:{...(options.body instanceof FormData?{}:{'Content-Type':'application/json'}),...(options.headers||{})}});
   const data = r.headers.get('content-type')?.includes('application/json') ? await r.json() : await r.text();
   if(!r.ok) throw new Error(data.error || 'Request failed ('+r.status+')');
   return data;
 };
 const toast = msg => { const e=$('#toast'); if(!e)return; e.textContent=msg;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),2800); };
 const showAuth = (show=true) => { $('#authwall').classList.toggle('show',show); document.body.classList.toggle('auth-required',show); };
 const authHTML = `<div id="authwall" class="authwall show"><div class="authcard"><div class="logo authlogo"><span>◇</span></div><div class="eyebrow">KD INDUSTRIES · PRIVATE WORKSPACE</div><h1>Welcome to <span>KD Hologram.</span></h1><p>Sign in to your team’s intelligence workspace.</p><form id="loginform"><label>Email address<input id="loginemail" type="email" autocomplete="username" required placeholder="you@company.com"></label><label>Password<input id="loginpassword" type="password" autocomplete="current-password" required placeholder="Your password"></label><label id="mfalabel" class="hidden">Authenticator code<input id="mfatoken" inputmode="numeric" autocomplete="one-time-code" placeholder="123456"></label><button class="primary authsubmit" type="submit">Sign in securely ↗</button><div id="autherror" role="alert"></div></form><div id="signuphint">Accounts are provisioned by your workspace administrator.</div><small>Protected workspace · Session-based sign-in</small></div></div>`;
 document.body.insertAdjacentHTML('beforeend',authHTML);
 const css=document.createElement('style');css.textContent=`.authwall{position:fixed;inset:0;z-index:1000;display:none;place-items:center;padding:20px;background:radial-gradient(ellipse at 50% 0%,#30255b 0,rgba(8,10,16,.97) 58%);backdrop-filter:blur(18px)}.authwall.show{display:grid}.authcard{width:min(100%,430px);padding:34px;border:1px solid #34304d;background:#0e121c;border-radius:20px;box-shadow:0 30px 100px #0009}.authlogo{margin-bottom:24px;color:#b9a6ff;font-size:25px}.authcard h1{font-size:29px;letter-spacing:-.04em;margin:12px 0}.authcard h1 span{color:#b9a6ff}.authcard p{color:#98a4b9;margin:0 0 24px}.authcard form{display:grid;gap:14px}.authcard label{font-size:12px;color:#c5cede;display:grid;gap:7px}.authcard input{width:100%;background:#151b27;color:#f4f7ff;border:1px solid #30384a;border-radius:9px;padding:12px;outline:none}.authcard input:focus{border-color:#9582fa}.authsubmit{width:100%;margin-top:4px}.authcard>small{display:block;color:#6f7b91;text-align:center;margin-top:20px;font-size:10px}.authcard #signuphint{font-size:11px;color:#8290a7;margin-top:15px;text-align:center}.authcard #autherror{font-size:12px;color:#ff9caa;min-height:16px}.hidden{display:none!important}body.auth-required{overflow:hidden}@media(max-width:480px){.authcard{padding:24px}}`;document.head.appendChild(css);
 async function refreshAuth(){
   try{const d=await api('/api/auth/me');if(d.user){showAuth(false);$('#loginemail').value=d.user.email;const profile=document.querySelector('.profile');if(profile){profile.querySelector('.avatar').textContent=(d.user.name||'KD').split(/\s+/).map(x=>x[0]).join('').slice(0,2).toUpperCase();profile.querySelector('b').textContent=d.user.name;profile.querySelector('small').textContent=d.user.role==='admin'?'Workspace owner':'Workspace member';} await loadConversations();}else showAuth(true);}catch{showAuth(true);}
 }
 $('#loginform').addEventListener('submit',async e=>{
   e.preventDefault();$('#autherror').textContent='';
   try{const d=await api('/api/auth/login',{method:'POST',body:JSON.stringify({email:$('#loginemail').value,password:$('#loginpassword').value,token:$('#mfatoken').value})});if(d.user){showAuth(false);toast('Welcome back, '+d.user.name);await loadConversations();}}
   catch(err){$('#autherror').textContent=err.message;if(/authenticator code/i.test(err.message))$('#mfalabel').classList.remove('hidden');}
 });
 const oldNew=$('#newchat')?.onclick;
 if($('#newchat'))$('#newchat').onclick=()=>{if($('#authwall').classList.contains('show'))return;$('#prompt').value='';$('#response').classList.remove('show');activeConversation=null;toast('New conversation ready');$('#prompt').focus();};
 let activeConversation=null, selectedFiles=[];
 async function loadConversations(){
   try{const d=await api('/api/conversations');const b=document.querySelector('[data-view="history"]');if(b)b.title=d.conversations.length+' saved conversations';window.kdHologramConversations=d.conversations;}catch{}
 }
 const fileInput=$('#fileinput');
 if(fileInput)fileInput.addEventListener('change',()=>{selectedFiles=[...fileInput.files];toast(selectedFiles.length+' file(s) selected. Text, Markdown, CSV, and JSON are supported.');});
 async function uploadFiles(){
   if(!selectedFiles.length)return [];
   const fd=new FormData();selectedFiles.forEach(f=>fd.append('files',f));
   const d=await api('/api/uploads',{method:'POST',body:fd});
   selectedFiles=[];fileInput.value='';return d.files||[];
 }
 if($('#send'))$('#send').onclick=async()=>{
   const text=$('#prompt').value.trim();if(!text&&!selectedFiles.length){toast('Write a message or attach a file first.');return;}
   $('#send').disabled=true;$('#send').textContent='Working…';const out=$('#response');out.classList.add('show');out.textContent='';
   try{
     const files=await uploadFiles();const result=await api('/api/chat',{method:'POST',body:JSON.stringify({message:text||'Summarize and explain the attached files.',conversationId:activeConversation,model:$('#model').value,files})});
     if(!result.providerConfigured){activeConversation=result.conversationId;out.textContent=result.content;await loadConversations();return;}
     activeConversation=result.conversationId;
     // Streaming responses use SSE. The initial response above will only be JSON for the no-provider fallback.
   }catch(err){out.textContent='Could not send: '+err.message;}finally{$('#send').disabled=false;$('#send').textContent='Send ↗';}
 };
 // Use the streaming endpoint directly. Keep the reader in this wrapper so each token paints immediately.
 if($('#send'))$('#send').onclick=async()=>{
   const text=$('#prompt').value.trim();if(!text&&!selectedFiles.length){toast('Write a message or attach a file first.');return;}
   $('#send').disabled=true;$('#send').textContent='Streaming…';const out=$('#response');out.classList.add('show');out.textContent='';
   try{
     const files=await uploadFiles();
     const response=await fetch('/api/chat',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text||'Summarize and explain the attached files.',conversationId:activeConversation,model:$('#model').value,files})});
     const ct=response.headers.get('content-type')||'';
     if(!response.ok){let err={};try{err=await response.json()}catch{}throw new Error(err.error||'Request failed');}
     if(ct.includes('application/json')){const d=await response.json();activeConversation=d.conversationId;out.textContent=d.content||'No response.';await loadConversations();return;}
     const reader=response.body.getReader(),decoder=new TextDecoder();let buf='';
     while(true){const {value,done}=await reader.read();if(done)break;buf+=decoder.decode(value,{stream:true});const chunks=buf.split('\n\n');buf=chunks.pop()||'';for(const chunk of chunks){const line=chunk.split('\n').find(x=>x.startsWith('data:'));if(!line)continue;try{const d=JSON.parse(line.slice(5).trim());if(d.type==='delta'){out.textContent+=d.text;}if(d.type==='done'){activeConversation=d.conversationId;toast('Response saved');}if(d.type==='error'){out.textContent+='\n\nError: '+d.message;}}catch{}}}
     await loadConversations();
   }catch(err){out.textContent='Could not send: '+err.message;}finally{$('#send').disabled=false;$('#send').textContent='Send ↗';}
 };
 const oldAttach=$('#attach')?.onclick;
 if($('#attach'))$('#attach').onclick=()=>$('#fileinput').click();
 const oldSee=$('#seeall')?.onclick;
 if($('#seeall'))$('#seeall').onclick=async()=>{document.querySelector('[data-view="history"]').click();try{const d=await api('/api/conversations');const panel=document.querySelector('#admin-list');if(panel){panel.innerHTML='';d.conversations.forEach(c=>{const item=document.createElement('div');item.className='model';item.innerHTML='<div class="modelicon">◷</div><div class="modelinfo"><b></b><small></small></div><button class="outline">Open</button>';item.querySelector('b').textContent=c.title;item.querySelector('small').textContent=new Date(c.updated_at).toLocaleString();item.querySelector('button').onclick=async()=>{activeConversation=c.id;const m=await api('/api/conversations/'+c.id+'/messages');document.querySelector('[data-view="chat"]').click();$('#response').textContent=m.messages.map(x=>(x.role==='user'?'You':'AI')+': '+x.content).join('\n\n');$('#response').classList.add('show');};panel.appendChild(item);});}}catch(e){toast(e.message)}};
 document.querySelectorAll('[data-view="admin"]').forEach(b=>b.addEventListener('click',async()=>{try{const d=await api('/api/admin/overview');const list=$('#admin-list');if(list){list.innerHTML='';const title=document.createElement('div');title.className='model';title.innerHTML='<div class="modelicon">♙</div><div class="modelinfo"><b>Workspace users</b><small></small></div>';title.querySelector('small').textContent=d.users.length+' accounts · '+d.conversations+' conversations';list.appendChild(title);d.users.forEach(u=>{const item=document.createElement('div');item.className='model';item.innerHTML='<div class="modelicon">♙</div><div class="modelinfo"><b></b><small></small></div><span class="pill"></span>';item.querySelector('b').textContent=u.name;item.querySelector('small').textContent=u.email;item.querySelector('.pill').textContent=u.role;list.appendChild(item)});d.models.forEach(m=>{const item=document.createElement('div');item.className='model';item.innerHTML='<div class="modelicon">⬡</div><div class="modelinfo"><b></b><small></small></div><span class="pill"></span>';item.querySelector('b').textContent=m.name;item.querySelector('small').textContent=m.model+' · '+m.base_url;item.querySelector('.pill').textContent=m.enabled?'Enabled':'Disabled';list.appendChild(item)});}}catch(e){if(/Administrator role/i.test(e.message))toast('Admin console requires an administrator account.');else toast(e.message)}}));
 const profile=document.querySelector('.profile');if(profile){const btn=document.createElement('button');btn.className='outline';btn.textContent='Sign out';btn.style.margin='12px 0 0 4px';btn.style.fontSize='10px';btn.onclick=async()=>{try{await api('/api/auth/logout',{method:'POST'});}catch{}showAuth(true);$('#loginpassword').value='';toast('Signed out');};profile.parentElement.appendChild(btn);}
 refreshAuth();
})();