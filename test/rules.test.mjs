// Тесты правил Router — включая ФИКС дедупликации под реальный payload game-server.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Router,defaults,validate} from '../agent/rules.mjs';

test('final streak only, duplicate final ignored and event limit 12',()=>{
  const r=new Router();
  const e={type:'gift',giftType:1,user:'u',groupId:'g',giftName:'Rose',giftValue:1,repeatCount:100};
  assert.deepEqual(r.accept({...e,repeatEnd:false}),[]);           // streak не закончился
  assert.deepEqual(r.accept(e),[]);                                 // giftType=1 без repeatEnd=true
  assert.equal(r.accept({...e,repeatEnd:true})[0].count,12);        // лимит 12
  assert.deepEqual(r.accept({...e,repeatEnd:true}),[]);             // дедуп повторной доставки
  assert.throws(()=>validate({...defaults,maxPerEvent:13}));
});

test('likes per user and follow once',()=>{
  const r=new Router();
  assert.deepEqual(r.accept({type:'like',user:'a',likeCount:99}),[]);
  assert.deepEqual(r.accept({type:'like',user:'b',likeCount:1}),[]);
  assert.equal(r.accept({type:'like',user:'a',likeCount:1})[0].action,'boost');
  assert.equal(r.accept({type:'follow',user:'a'})[0].action,'shield');
  assert.deepEqual(r.accept({type:'follow',user:'a'}),[]);
});

// ── ФИКС: дедуп по реальному payload без groupId/eventId ──
test('dedup works with REAL server payload (no groupId/eventId) via composite key',()=>{
  const r=new Router();
  const base={type:'gift',giftType:2,user:'viewer1',userId:'viewer1',nickname:'Viewer1',giftName:'Rose',giftId:'5655',giftValue:1,diamondCount:1,repeatCount:1,timestamp:1000};
  const first=r.accept({...base});
  assert.equal(first.length,1);
  assert.equal(first[0].action,'car');
  // Повторная доставка ТОГО ЖЕ события (тот же timestamp) → дедуп
  assert.deepEqual(r.accept({...base}),[]);
  // Новое событие с другим timestamp → НЕ дедуп
  assert.equal(r.accept({...base,timestamp:1001}).length,1);
});

test('dedup prefers explicit groupId/eventId when present',()=>{
  const r=new Router();
  const e={type:'gift',giftType:2,user:'u',groupId:'grp-1',giftName:'Rose',giftId:'5655',giftValue:1,repeatCount:1,timestamp:5};
  assert.equal(r.accept(e).length,1);
  assert.deepEqual(r.accept({...e,eventId:'grp-1'}),[]);            // тот же id → дедуп
});

test('two distinct gifts same user same ms do not collapse (giftId differs)',()=>{
  const r=new Router();
  const a={type:'gift',giftType:2,user:'u',giftName:'Rose',giftId:'5655',giftValue:1,repeatCount:1,timestamp:7};
  const b={type:'gift',giftType:2,user:'u',giftName:'Galaxy',giftId:'9999',giftValue:1000,repeatCount:1,timestamp:7};
  assert.equal(r.accept(a).length,1);
  assert.equal(r.accept(b).length,1);   // другой giftId → не схлопываем
});

// ⚠️ ОГРАНИЧЕНИЕ (документируем, не прячем): два ИДЕНТИЧНЫХ события одного зрителя
// за одну мс без серверного ID неразличимы → второе схлопывается.
// Это ОЖИДАЕМОЕ поведение эвристики. Фикс — уникальный eventId/msgId из game-server.
test('KNOWN LIMITATION: two IDENTICAL gifts same user same ms collapse without server id',()=>{
  const r=new Router();
  const same={type:'gift',giftType:2,user:'u',giftName:'Rose',giftId:'5655',giftValue:1,repeatCount:1,timestamp:7};
  assert.equal(r.accept({...same}).length,1);
  assert.equal(r.accept({...same}).length,0); // ← схлопнуто (ограничение)
});

// С уникальным eventId от сервера — оба идентичных события проходят.
test('with server eventId: two identical gifts both pass, repeat delivery ignored',()=>{
  const r=new Router();
  const base={type:'gift',giftType:2,user:'u',giftName:'Rose',giftId:'5655',giftValue:1,repeatCount:1,timestamp:7};
  assert.equal(r.accept({...base,eventId:'e1'}).length,1);
  assert.equal(r.accept({...base,eventId:'e2'}).length,1);   // другое событие → проходит
  assert.equal(r.accept({...base,eventId:'e1'}).length,0);   // повторная доставка e1 → игнор
});

test('Rose → car (per coin), other gift → truck (per 10 coins, min 1)',()=>{
  const r=new Router();
  const rose=r.accept({type:'gift',giftType:2,user:'u',giftName:'Rose',giftId:'5655',giftValue:1,repeatCount:3,timestamp:1});
  assert.equal(rose[0].action,'car'); assert.equal(rose[0].count,3);
  const big=r.accept({type:'gift',giftType:2,user:'u2',giftName:'Galaxy',giftId:'9999',giftValue:500,repeatCount:1,timestamp:2});
  assert.equal(big[0].action,'truck'); assert.equal(big[0].count,12); // 5000/10=500 → лимит 12
});

test('follow with firstTime=false ignored',()=>{
  const r=new Router();
  assert.deepEqual(r.accept({type:'follow',user:'z',firstTime:false}),[]);
  assert.equal(r.accept({type:'follow',user:'z',firstTime:true})[0].action,'shield');
});

test('name sanitization strips controls and ~ and clamps length',()=>{
  const r=new Router();
  const out=r.accept({type:'gift',giftType:2,user:'u',nickname:'A~B\n\tC\u0001',giftName:'Rose',giftId:'5655',giftValue:1,repeatCount:1,timestamp:3});
  assert.equal(out[0].name.includes('~'),false);
  assert.equal(out[0].name.includes('\n'),false);
  assert.ok(out[0].name.length<=40);
});
