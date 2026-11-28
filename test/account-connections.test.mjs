import assert from 'node:assert/strict';
import test from 'node:test';
import {createGitAccountConnections} from '../dist/index.js';
test('two account slots keep independent connections; a bound executor keeps its account',async()=>{
    let seq=0;const sessions=new Map(),disconnected=[];
    const desktop={async create(){const id=String(++seq);sessions.set(id,{connection:{mode:'desktop',proxyOrigin:`http://127.0.0.1:${4000+seq}`},
        account:{id:seq,login:`user${seq}`},bearer:id.repeat(43),expiresAt:Date.now()+100000});return id;},
        async begin(){return {userCode:'ABCD-EFGH',verificationUri:'https://github.com/login/device',expiresAt:Date.now()+100000};},
        async finish(){},async authorizeRepository(id){return sessions.get(id);},async getSession(id){return sessions.get(id);},
        async disconnect(id){disconnected.push(id);sessions.delete(id);}};
    const accounts=createGitAccountConnections({desktop});
    const a=await accounts.begin('https://github.com/owner/repo.git','desktop',true);await accounts.refresh(a.id);
    const b=await accounts.begin('https://github.com/owner/repo.git','desktop',true);await accounts.refresh(b.id);
    assert.equal(accounts.list().filter(a=>a.state.status==='connected').length,2);
    const getA=accounts.bind(a.id),getB=accounts.bind(b.id);
    assert.equal((await getA('https://github.com/owner/repo.git',true)).account.login,'user1');
    await accounts.disconnect(b.id);
    assert.equal((await getA('https://github.com/owner/repo.git',true)).account.login,'user1');
    assert.equal(await getB('https://github.com/owner/repo.git',true),null);
    assert(!disconnected.includes(a.id));await accounts.dispose();
});

test('pair Cloudflare sign-in forces account selection and retains independent BFF tickets',async()=>{
    let sequence=0;const opened=[],revoked=[];
    const state='s'.repeat(43),bffOrigin='https://auth.example',proxyOrigin='https://git.example';
    const fetch=async(url,init)=>{
        if(url.endsWith('/start')){sequence++;return Response.json({ticket:state+'.'+String(sequence).repeat(43),
            authorizationUrl:'https://github.com/login/oauth/authorize?state='+state});}
        const token=init.headers.Authorization.split('.').at(-1)[0];
        if(init.method==='DELETE'){revoked.push(token);return new Response(null,{status:204});}
        return Response.json({connection:{mode:'cloudflare',proxyOrigin},account:{id:Number(token),login:'user'+token},
            bearer:state+'.'+('b'+token).repeat(22).slice(0,43),expiresAt:Date.now()+60000});
    };
    const accounts=createGitAccountConnections({cloudflare:{bffOrigin,proxyOrigin,fetch}});
    const a=await accounts.begin('https://github.com/owner/repo.git','cloudflare',true);opened.push(a.authorization.url);await accounts.refresh(a.id);
    const b=await accounts.begin('https://github.com/owner/repo.git','cloudflare',true);opened.push(b.authorization.url);await accounts.refresh(b.id);
    assert(opened.every(url=>new URL(url).searchParams.get('prompt')==='select_account'));
    assert.equal((await accounts.bind(a.id)('https://github.com/owner/repo.git',true)).account.login,'user1');
    await accounts.disconnect(b.id);assert.deepEqual(revoked,['2']);
    assert.equal((await accounts.bind(a.id)('https://github.com/owner/repo.git',true)).account.login,'user1');await accounts.dispose();
});

test('a read-only participant upgrades for push without a duplicate participant or redirecting an old executor',async()=>{
    let counter=0;const sessions=new Map();
    const desktop={async create(){const id=String(++counter);sessions.set(id,{connection:{mode:'desktop',proxyOrigin:`http://127.0.0.1:${4500+counter}`},
        account:{id:1,login:'alice'},bearer:id.repeat(43),expiresAt:Date.now()+60000});return id;},
        async begin(){return {userCode:'ABCD-EFGH',verificationUri:'https://github.com/login/device',expiresAt:Date.now()+60000};},
        async finish(){},async authorizeRepository(id){return sessions.get(id);},async getSession(id){return sessions.get(id);},
        async disconnect(id){sessions.delete(id);}};
    const accounts=createGitAccountConnections({desktop}),remote='https://github.com/owner/repo.git';
    const read=await accounts.begin(remote);await accounts.refresh(read.id);
    const oldExecutor=accounts.bind(read.id);
    assert.equal(accounts.list()[0].write,false);assert.equal(await oldExecutor(remote,true),null);
    assert.equal((await oldExecutor(remote,false)).account.login,'alice');
    const write=await accounts.begin(remote,'desktop',true),upgraded=await accounts.refresh(write.id);
    assert.equal(upgraded.id,read.id);assert.equal(accounts.list().length,1);assert.equal(accounts.list()[0].write,true);
    assert.equal(await oldExecutor(remote,true),null);
    assert.equal((await accounts.bind(read.id)(remote,true)).account.login,'alice');await accounts.dispose();
});

test('offline sign-out immediately blocks a bound executor and persists only a display receipt for restart',async()=>{
    const data=new Map(),storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};
    const state='s'.repeat(43),ticket=state+'.'+'t'.repeat(43),bearer=state+'.'+'b'.repeat(43);
    let offline=true;
    const accounts=createGitAccountConnections({signOutStorage:storage,cloudflare:{bffOrigin:'https://auth.example',proxyOrigin:'https://git.example',
        fetch:async(url,init)=>{
            if(url.endsWith('/start'))return Response.json({ticket,authorizationUrl:'https://github.com/login/oauth/authorize?state='+state});
            if(init.method==='DELETE') {if(offline)throw Error('offline');return new Response(null,{status:204});}
            return Response.json({connection:{mode:'cloudflare',proxyOrigin:'https://git.example'},account:{id:1,login:'alice'},bearer,expiresAt:Date.now()+60000});
        }}});
    const view=await accounts.begin('https://github.com/owner/repo.git');await accounts.refresh(view.id);
    const executor=accounts.bind(view.id);
    const attempt=accounts.disconnect(view.id);
    assert.equal(accounts.list()[0].state.status,'disconnected');assert.equal(await executor('https://github.com/owner/repo.git'),null);
    await assert.rejects(attempt);
    const receipt=accounts.list()[0].signOut;assert.equal(receipt.local,'stopped');assert.equal(receipt.session,'pending');assert.equal(receipt.retryable,true);
    const disk=[...data.values()].join();assert(!disk.includes(ticket));assert(!disk.includes(bearer));assert(!/gh[ur]_|Authorization/.test(disk));
    const restored=createGitAccountConnections({signOutStorage:storage});
    assert.equal(restored.list()[0].signOut.retryable,false);assert.equal(restored.list()[0].signOut.session,'pending');
    assert.throws(()=>restored.bind(view.id),/SESSION_REQUIRED/);
    offline=false;await accounts.disconnect(view.id);assert.equal(accounts.list()[0].signOut.session,'revoked');
    assert.equal(accounts.list()[0].signOut.github,'unconfirmed');assert.equal(await executor('https://github.com/owner/repo.git'),null);
});

test('dispose stops every account and cannot be undone by a late getSession response',async()=>{
    let sequence=0,release;const pending=new Promise(resolve=>{release=resolve;}),stopped=[];
    const sessions=new Map();let delayed=false;
    const desktop={async create(){const id=String(++sequence);sessions.set(id,{connection:{mode:'desktop',proxyOrigin:'http://127.0.0.1:4000'},
        account:{id:Number(id),login:'user'+id},bearer:id.repeat(43),expiresAt:Date.now()+60000});return id;},
        async begin(){return {userCode:'ABCD-EFGH',verificationUri:'https://github.com/login/device',expiresAt:Date.now()+60000};},async finish(){},
        async authorizeRepository(id){return sessions.get(id);},async getSession(id){const result=sessions.get(id);if(delayed)await pending;return result;},
        async disconnect(id){stopped.push(id);sessions.delete(id);}};
    const accounts=createGitAccountConnections({desktop}),remote='https://github.com/owner/repo.git';
    const a=await accounts.begin(remote);await accounts.refresh(a.id);const b=await accounts.begin(remote);await accounts.refresh(b.id);
    delayed=true;const response=accounts.bind(a.id)(remote);await accounts.dispose();release();
    assert.equal(await response,null);assert.ok(stopped.includes(a.id)&&stopped.includes(b.id));
    await assert.rejects(accounts.begin(remote),/GIT_UNAVAILABLE/);
});

test('an unavailable receipt store cannot prevent stopping access and is exposed to the view',async()=>{
    const state='s'.repeat(43),ticket=state+'.'+'t'.repeat(43);
    const accounts=createGitAccountConnections({signOutStorage:{getItem(){throw Error('denied');},setItem(){throw Error('full');}},
        cloudflare:{bffOrigin:'https://auth.example',proxyOrigin:'https://git.example',fetch:async(url,init)=>{
            if(url.endsWith('/start'))return Response.json({ticket,authorizationUrl:'https://github.com/login/oauth/authorize?state='+state});
            if(init.method==='DELETE')return new Response(null,{status:204});
            return Response.json({connection:{mode:'cloudflare',proxyOrigin:'https://git.example'},account:{id:1,login:'alice'},
                bearer:state+'.'+'b'.repeat(43),expiresAt:Date.now()+60000});
        }}});
    const view=await accounts.begin('https://github.com/owner/repo.git');await accounts.refresh(view.id);
    const get=accounts.bind(view.id);await accounts.disconnect(view.id);
    assert.equal(await get('https://github.com/owner/repo.git'),null);assert.equal(accounts.list()[0].signOut.recorded,false);
    assert.equal(accounts.list()[0].signOut.session,'revoked');
});

test('equal login names with different GitHub IDs never merge and a bound account cannot change IDs',async()=>{
    let sequence=0,changed=false;const sessions=new Map();
    const desktop={async create(){const id=String(++sequence);sessions.set(id,{connection:{mode:'desktop',proxyOrigin:'http://127.0.0.1:4000'},
        account:{id:Number(id),login:'same-name'},bearer:id.repeat(43),expiresAt:Date.now()+60000});return id;},
        async begin(){return {userCode:'ABCD-EFGH',verificationUri:'https://github.com/login/device',expiresAt:Date.now()+60000};},async finish(){},
        async authorizeRepository(id){return sessions.get(id);},async getSession(id){const session=sessions.get(id);return changed?
            {...session,account:{id:99,login:'same-name'}}:session;},async disconnect(id){sessions.delete(id);}};
    const accounts=createGitAccountConnections({desktop}),remote='https://github.com/owner/repo.git';
    const a=await accounts.begin(remote);await accounts.refresh(a.id);const b=await accounts.begin(remote);await accounts.refresh(b.id);
    assert.equal(accounts.list().length,2);const get=accounts.bind(a.id);assert.equal((await get(remote)).account.id,1);
    changed=true;assert.equal(await get(remote),null);await accounts.dispose();
});

test('a legacy host without a GitHub ID cannot issue a pair executor',async()=>{
    const session={connection:{mode:'desktop',proxyOrigin:'http://127.0.0.1:4000'},account:{login:'alice'},bearer:'a'.repeat(43),expiresAt:Date.now()+60000};
    const accounts=createGitAccountConnections({desktop:{async create(){return 'a';},async begin(){return {userCode:'ABCD-EFGH',
        verificationUri:'https://github.com/login/device',expiresAt:Date.now()+60000};},async finish(){},async authorizeRepository(){return session;},
        async getSession(){return session;},async disconnect(){}}});
    const a=await accounts.begin('https://github.com/owner/repo.git');await assert.rejects(accounts.refresh(a.id),/ACCOUNT_ID_REQUIRED/);
    assert.equal(accounts.list()[0].state.status,'reauth-required');assert.throws(()=>accounts.bind(a.id),/ACCOUNT_ID_REQUIRED/);await accounts.dispose();
});

test('legacy Desktop token settings join the same account list, preserve review grants and sign out through the pool',async()=>{
    const {createGitConnectionSettings}=await import('../dist/index.js');let stopped=0;
    const session={connection:{mode:'desktop',proxyOrigin:'http://127.0.0.1:4000'},account:{id:7,login:'pat-user'},bearer:'b'.repeat(43),expiresAt:Date.now()+60000};
    const desktop={async getAuthMethods(){return ['fine-grained-pat'];},async connectPersonalAccessToken(){return {status:'connected'};},
        async authorizeRepository(){return session;},async getSession(){return session;},async disconnect(){stopped++;}};
    const primary=createGitConnectionSettings({desktop}),accounts=createGitAccountConnections({primary,signOutStorage:undefined});
    assert.deepEqual(await accounts.getDesktopAuthMethods(),['fine-grained-pat']);
    const slot=await accounts.begin('https://github.com/owner/repo','desktop',true,true,{method:'fine-grained-pat',remember:false});
    assert.equal(accounts.list()[0].state.account.id,7);assert.equal(accounts.list()[0].review,true);
    const execute=accounts.bind(slot.id);assert.equal((await execute('https://github.com/owner/repo',true,true)).account.id,7);
    await accounts.disconnect(slot.id);assert.equal(await execute('https://github.com/owner/repo',true),null);
    assert.equal(accounts.list()[0].signOut.session,'revoked');assert.equal(stopped,1);
});

test('a pending legacy token connection cannot be replaced concurrently or revived after sign-out',async()=>{
    const {createGitConnectionSettings}=await import('../dist/index.js');let release;
    const pending=new Promise(resolve=>{release=resolve;});
    const session={connection:{mode:'desktop',proxyOrigin:'http://127.0.0.1:4000'},account:{id:7,login:'pat-user'},bearer:'b'.repeat(43),expiresAt:Date.now()+60000};
    const primary=createGitConnectionSettings({desktop:{async getAuthMethods(){return ['fine-grained-pat'];},
        connectPersonalAccessToken:()=>pending,async getSession(){return session;},async authorizeRepository(){throw Error('late authority');},async disconnect(){}}});
    const accounts=createGitAccountConnections({primary});
    const first=accounts.begin('https://github.com/owner/repo','desktop',true,false,{method:'fine-grained-pat',remember:false});
    while(!accounts.list().length)await new Promise(resolve=>setTimeout(resolve,0));
    await assert.rejects(accounts.begin('https://github.com/owner/repo','desktop',true,false,{method:'fine-grained-pat',remember:false}),/GIT_UNAVAILABLE/);
    await accounts.disconnect(accounts.list()[0].id);release({status:'connected'});
    await assert.rejects(first,/SESSION_REQUIRED/);assert.equal(accounts.list().filter(a=>a.state.status==='connected').length,0);
});

test('moves every account connection for a renamed repository without a new login', async () => {
    let seq = 0; const sessions = new Map(), authorized = [];
    const desktop = {async create() {const id = String(++seq); sessions.set(id, {connection: {mode: 'desktop', proxyOrigin: `http://127.0.0.1:${4000 + seq}`},
        account: {id: seq, login: `user${seq}`}, bearer: id.repeat(43), expiresAt: Date.now() + 100000}); return id;},
        async begin() {return {userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', expiresAt: Date.now() + 100000};},
        async finish() {}, async authorizeRepository(id, remote) {authorized.push(remote); return sessions.get(id);},
        async getSession(id) {return sessions.get(id);}, async disconnect(id) {sessions.delete(id);}};
    const accounts = createGitAccountConnections({desktop});
    const remote = 'https://github.com/owner/repo.git', renamed = 'https://github.com/owner/renamed.git';
    const a = await accounts.begin(remote, 'desktop', true); await accounts.refresh(a.id);
    assert.equal(await accounts.renameRemote('https://github.com/owner/other.git', renamed), false);
    assert.equal(await accounts.renameRemote(remote, renamed), true);
    assert.equal(await accounts.bind(a.id)(remote, true), null);
    assert.equal((await accounts.bind(a.id)(renamed, true)).account.login, 'user1');
    assert.deepEqual(authorized, [remote]);
    await accounts.dispose();
});
