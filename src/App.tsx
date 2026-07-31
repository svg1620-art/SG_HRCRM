import { FormEvent, useEffect, useMemo, useState } from 'react';
import { BriefcaseBusiness, ChevronDown, CircleHelp, Filter, LayoutDashboard, ListChecks, MessageSquareText, MoreHorizontal, Plus, Search, Settings, SlidersHorizontal, Sparkles, Users, X } from 'lucide-react';
import { candidates as seed, Candidate, Stage, stages, vacancies } from './data';

const scoreTone=(n:number)=>n>=85?'great':n>=70?'good':'low';
type VacancyOption={id?:number;name:string;active:boolean;count:number;newCount:number};
type Criterion={id?:number;name:string;description:string;weight:number;position:number};
type AppTab='board'|'candidates'|'vacancies'|'dialogs'|'criteria'|'settings';
type HhState={connected:boolean;loading:boolean;message?:string};
type AuthUser={id:number;username:string;displayName:string;role:'owner'|'admin'};
const tabTitles:Record<AppTab,{title:string;subtitle:string}>={
 board:{title:'Воронка кандидатов',subtitle:'Входящие отклики из hh.ru'},
 candidates:{title:'Кандидаты',subtitle:'Все входящие кандидаты по активным вакансиям'},
 vacancies:{title:'Вакансии',subtitle:'Активные вакансии и количество откликов'},
 dialogs:{title:'Диалоги',subtitle:'Кандидаты, с которыми идёт общение в hh.ru'},
 criteria:{title:'Критерии оценки',subtitle:'Настройте веса скоринга отдельно для каждой вакансии'},
 settings:{title:'Настройки',subtitle:'Подключения и синхронизация CRM'},
};
export function App(){
 const [auth,setAuth]=useState<AuthUser|null|undefined>(undefined);
 const [items,setItems]=useState(seed); const [selected,setSelected]=useState<Candidate|null>(null); const [vacancy,setVacancy]=useState('Все вакансии'); const [tab,setTab]=useState<AppTab>('board'); const [query,setQuery]=useState('');
 const [vacancyOptions,setVacancyOptions]=useState<VacancyOption[]>(vacancies);
 const [hh,setHh]=useState<HhState>({connected:false,loading:true});
 useEffect(()=>{fetch('/api/auth/status').then(r=>r.json()).then(data=>setAuth(data.authenticated?data.user:null)).catch(()=>setAuth(null))},[]);
 useEffect(()=>{if(!auth)return;fetch('/api/hh/status').then(r=>r.json()).then(data=>setHh({connected:Boolean(data.hh?.connected),loading:false})).catch(()=>setHh({connected:false,loading:false}))},[auth]);
 const loadCrm=async()=>{try{const r=await fetch('/api/crm');const data=await r.json();if(data.vacancies?.length)setVacancyOptions(data.vacancies.map((v:{id:number;name:string})=>({id:v.id,name:v.name,active:true,count:0,newCount:0})));if(data.candidates?.length)setItems(data.candidates.map((c:any)=>{const parts=String(c.name).trim().split(/\s+/);return {...c,stage:c.stage as Stage,score:c.score??0,updated:'недавно',initials:parts.slice(0,2).map((p:string)=>p[0]).join('').toUpperCase(),color:'#dce7e2',factors:c.factors||[]}}))}catch{}};
 useEffect(()=>{if(auth)loadCrm()},[auth]);
 const visible=useMemo(()=>items.filter(c=>(vacancy==='Все вакансии'||c.vacancy===vacancy)&&(!query||`${c.name} ${c.role} ${c.vacancy}`.toLowerCase().includes(query.toLowerCase()))),[items,vacancy,query]);
 const move=(id:number,stage:Stage)=>{setItems(x=>x.map(c=>c.id===id?{...c,stage}:c));setSelected(s=>s?.id===id?{...s,stage}:s);fetch(`/api/candidates/${id}/stage`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({stage})}).catch(()=>{})};
 const syncHh=async()=>{setHh(s=>({...s,loading:true,message:undefined}));try{const r=await fetch('/api/hh/sync',{method:'POST'});const data=await r.json();if(!r.ok)throw new Error(data.error);setHh({connected:true,loading:false,message:`${data.candidates} откликов`})}catch(error){setHh(s=>({...s,loading:false,message:error instanceof Error?error.message:'Ошибка'}))}};
 if(auth===undefined)return <div className="auth-loading">Загрузка SG HR CRM…</div>;
 if(!auth)return <LoginScreen onLogin={setAuth}/>;
 const signOut=async()=>{await fetch('/api/auth/logout',{method:'POST'});setAuth(null)};
 return <div className="shell">
  <aside><div className="brand"><span>SG</span><b>HR CRM</b></div><nav><button className={tab==='board'?'active':''} onClick={()=>setTab('board')}><LayoutDashboard/>Воронка</button><button className={tab==='candidates'?'active':''} onClick={()=>setTab('candidates')}><Users/>Кандидаты</button><button className={tab==='vacancies'?'active':''} onClick={()=>setTab('vacancies')}><BriefcaseBusiness/>Вакансии</button><button className={tab==='dialogs'?'active':''} onClick={()=>setTab('dialogs')}><MessageSquareText/>Диалоги <i>{items.filter(c=>c.stage==='Диалог').length}</i></button><button className={tab==='criteria'?'active':''} onClick={()=>setTab('criteria')}><ListChecks/>Критерии</button></nav><div className="aside-bottom"><button onClick={()=>location.assign('mailto:sg@service.guru')}><CircleHelp/>Поддержка</button><button className={tab==='settings'?'active':''} onClick={()=>setTab('settings')}><Settings/>Настройки</button><button className="profile" onClick={signOut} title="Выйти"><div>{auth.displayName.slice(0,2).toUpperCase()}</div><span><b>{auth.displayName}</b><small>{auth.role==='owner'?'Владелец':'Администратор'}</small></span><ChevronDown/></button></div></aside>
  <main><header><div><h1>{tabTitles[tab].title}</h1><p>{tabTitles[tab].subtitle}</p></div><div className="header-actions"><label className="search"><Search/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Поиск кандидата"/></label><button className="primary" onClick={syncHh} disabled={hh.loading}><SlidersHorizontal/>{hh.loading?'Обновление…':'Обновить из HH'}</button></div></header>
  {tab==='board'&&<Board items={items} visible={visible} vacancy={vacancy} vacancies={vacancyOptions} setVacancy={setVacancy} hh={hh} syncHh={syncHh} select={setSelected}/>}
  {tab==='candidates'&&<CandidatesView items={visible} select={setSelected}/>}
  {tab==='vacancies'&&<VacanciesView vacancies={vacancyOptions} items={items} open={name=>{setVacancy(name);setTab('board')}}/>}
  {tab==='dialogs'&&<DialogueSettings vacancies={vacancyOptions.filter(v=>v.id)}/>}
  {tab==='criteria'&&<Criteria vacancies={vacancyOptions.filter(v=>v.id)} candidates={items} onScored={async()=>{await loadCrm();setTab('board')}}/>}
  {tab==='settings'&&<SettingsView hh={hh} syncHh={syncHh} user={auth}/>}</main>
  {selected&&<CandidatePanel candidate={selected} close={()=>setSelected(null)} move={move}/>} </div>
}

function LoginScreen({onLogin}:{onLogin:(user:AuthUser)=>void}){
 const [username,setUsername]=useState('');
 const [password,setPassword]=useState('');
 const [loading,setLoading]=useState(false);
 const [error,setError]=useState('');
 const submit=async(e:FormEvent)=>{e.preventDefault();setLoading(true);setError('');try{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});const data=await r.json();if(!r.ok)throw new Error(data.error);onLogin(data.user)}catch(e){setError(e instanceof Error?e.message:'Не удалось войти')}finally{setLoading(false)}};
 return <main className="login-page"><form onSubmit={submit}><div className="login-brand"><span>SG</span><b>HR CRM</b></div><h1>Вход в систему</h1><p>Используйте личную учётную запись администратора.</p><label>Логин<input autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} required/></label><label>Пароль<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required/></label>{error&&<div className="login-error">{error}</div>}<button className="primary" disabled={loading}>{loading?'Входим…':'Войти'}</button></form></main>
}

function Board({items,visible,vacancy,vacancies,setVacancy,hh,syncHh,select}:{items:Candidate[];visible:Candidate[];vacancy:string;vacancies:VacancyOption[];setVacancy:(value:string)=>void;hh:HhState;syncHh:()=>void;select:(candidate:Candidate)=>void}){
 return <><section className="toolbar"><div className="select-wrap"><BriefcaseBusiness/><select value={vacancy} onChange={e=>setVacancy(e.target.value)}><option>Все вакансии</option>{vacancies.map(v=><option key={v.name}>{v.name}</option>)}</select></div>{hh.connected?<button className="sync sync-button" onClick={syncHh} disabled={hh.loading}><span></span>{hh.loading?'Синхронизация…':'hh.ru подключен'} <small>{hh.message||'обновить'}</small></button>:<button className="connect-hh" onClick={()=>location.assign('/api/hh/connect')} disabled={hh.loading}><span></span>{hh.loading?'Проверяем hh.ru…':'Подключить hh.ru'}</button>}</section><section className="stats"><div><small>Всего кандидатов</small><strong>{visible.length}</strong><em>в выборке</em></div><div><small>Средний скор</small><strong>{Math.round(visible.reduce((a,c)=>a+c.score,0)/(visible.filter(c=>c.score>0).length||1))}</strong><em>из 100</em></div><div><small>Ждут ответа</small><strong>{visible.filter(c=>c.stage==='Новый').length}</strong><em className="warn">новые</em></div><div><small>На интервью</small><strong>{items.filter(c=>c.stage==='Интервью').length}</strong><em>кандидатов</em></div></section><section className="board">{stages.slice(0,6).map(stage=><div className="column" key={stage}><div className="column-head"><span className={'dot '+stage.toLowerCase()}></span><b>{stage}</b><small>{visible.filter(c=>c.stage===stage).length}</small><MoreHorizontal/></div><div className="cards">{visible.filter(c=>c.stage===stage).map(c=><article key={c.id} onClick={()=>select(c)}><div className="candidate"><div className="avatar" style={{background:c.color}}>{c.initials}</div><div><b>{c.name}</b><small>{c.role}</small></div><span className={'score '+scoreTone(c.score)}>{c.score||'—'}</span></div><div className="meta"><span>{c.location}</span><span>{c.experience}</span></div><footer><span>{c.updated}</span><ChevronDown/></footer></article>)}</div></div>)}</section></>
}

function CandidatesView({items,select,empty='Кандидаты не найдены.'}:{items:Candidate[];select:(candidate:Candidate)=>void;empty?:string}){
 if(!items.length)return <section className="empty-state">{empty}</section>;
 return <section className="data-list">{items.map(c=><button key={c.id} onClick={()=>select(c)}><span className="avatar" style={{background:c.color}}>{c.initials}</span><span className="list-main"><b>{c.name}</b><small>{c.role} · {c.vacancy}</small></span><span>{c.location}</span><span className="stage-pill">{c.stage}</span><strong className={'score '+scoreTone(c.score)}>{c.score||'—'}</strong><ChevronDown/></button>)}</section>
}

function VacanciesView({vacancies,items,open}:{vacancies:VacancyOption[];items:Candidate[];open:(name:string)=>void}){
 return <section className="vacancy-list">{vacancies.map(v=>{const related=items.filter(c=>c.vacancy===v.name);return <button key={v.name} onClick={()=>open(v.name)}><span><b>{v.name}</b><small>Активная вакансия hh.ru</small></span><strong>{related.length}</strong><small>кандидатов</small><ChevronDown/></button>})}</section>
}

function SettingsView({hh,syncHh,user}:{hh:HhState;syncHh:()=>void;user:AuthUser}){
 return <div className="settings-stack"><section className="settings-view"><div><span className={hh.connected?'status-dot connected-dot':'status-dot'}></span><span><b>Интеграция hh.ru</b><small>{hh.connected?'Подключена и готова к синхронизации':'Требуется подключение аккаунта работодателя'}</small></span>{hh.connected?<button className="primary" onClick={syncHh} disabled={hh.loading}>{hh.loading?'Обновление…':'Синхронизировать'}</button>:<button className="primary" onClick={()=>location.assign('/api/hh/connect')}>Подключить</button>}</div><div><span className="status-dot connected-dot"></span><span><b>OpenAI</b><small>Ключ хранится в Railway и используется только сервером</small></span></div></section><ChangePassword/>{user.role==='owner'&&<AdminManager currentUser={user}/>}</div>
}

function ChangePassword(){
 const [form,setForm]=useState({currentPassword:'',newPassword:''});
 const [message,setMessage]=useState('');
 const submit=async(e:FormEvent)=>{e.preventDefault();setMessage('');try{const r=await fetch('/api/auth/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(form)});const data=await r.json();if(!r.ok)throw new Error(data.error);location.reload()}catch(e){setMessage(e instanceof Error?e.message:'Не удалось изменить пароль')}};
 return <section className="admin-manager"><form className="password-form" onSubmit={submit}><div><h2>Сменить пароль</h2><p>После изменения потребуется войти заново.</p></div><label>Текущий пароль<input type="password" value={form.currentPassword} onChange={e=>setForm({...form,currentPassword:e.target.value})} required/></label><label>Новый пароль<input type="password" minLength={10} value={form.newPassword} onChange={e=>setForm({...form,newPassword:e.target.value})} required/></label><button className="primary">Изменить</button></form>{message&&<p className="criteria-message">{message}</p>}</section>
}

function AdminManager({currentUser}:{currentUser:AuthUser}){
 const [admins,setAdmins]=useState<Array<AuthUser&{active:boolean}>>([]);
 const [form,setForm]=useState({displayName:'',username:'',password:''});
 const [message,setMessage]=useState('');
 const [loading,setLoading]=useState(false);
 const load=async()=>{const r=await fetch('/api/admins');const data=await r.json();if(!r.ok)throw new Error(data.error);setAdmins(data.admins)};
 useEffect(()=>{load().catch(e=>setMessage(e.message))},[]);
 const create=async(e:FormEvent)=>{e.preventDefault();setLoading(true);setMessage('');try{const r=await fetch('/api/admins',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(form)});const data=await r.json();if(!r.ok)throw new Error(data.error);setForm({displayName:'',username:'',password:''});await load();setMessage('Администратор создан')}catch(e){setMessage(e instanceof Error?e.message:'Не удалось создать администратора')}finally{setLoading(false)}};
 const toggle=async(admin:AuthUser&{active:boolean})=>{setLoading(true);setMessage('');try{const r=await fetch(`/api/admins/${admin.id}/active`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({active:!admin.active})});const data=await r.json();if(!r.ok)throw new Error(data.error);await load()}catch(e){setMessage(e instanceof Error?e.message:'Не удалось изменить доступ')}finally{setLoading(false)}};
 return <section className="admin-manager"><div className="section-head"><div><h2>Администраторы</h2><p>У каждого сотрудника собственный логин и пароль.</p></div></div><div className="admin-list">{admins.map(admin=><div key={admin.id}><span><b>{admin.displayName}</b><small>{admin.username} · {admin.role==='owner'?'владелец':'администратор'}</small></span><em className={admin.active?'active-user':'inactive-user'}>{admin.active?'Активен':'Отключён'}</em>{admin.role!=='owner'&&admin.id!==currentUser.id&&<button className="ghost-action" disabled={loading} onClick={()=>toggle(admin)}>{admin.active?'Отключить':'Включить'}</button>}</div>)}</div><form className="admin-form" onSubmit={create}><h3>Добавить администратора</h3><label>Имя<input value={form.displayName} onChange={e=>setForm({...form,displayName:e.target.value})} required maxLength={100}/></label><label>Логин<input value={form.username} onChange={e=>setForm({...form,username:e.target.value})} required minLength={3} maxLength={80}/></label><label>Временный пароль<input type="password" value={form.password} onChange={e=>setForm({...form,password:e.target.value})} required minLength={10}/></label><button className="primary" disabled={loading}>{loading?'Сохранение…':'Создать администратора'}</button></form>{message&&<p className="criteria-message">{message}</p>}</section>
}

function DialogueSettings({vacancies}:{vacancies:VacancyOption[]}){
 const [vacancyId,setVacancyId]=useState<number|undefined>();
 const [enabled,setEnabled]=useState(false);
 const [greeting,setGreeting]=useState('');
 const [questions,setQuestions]=useState<string[]>([]);
 const [stats,setStats]=useState<Record<string,number>>({});
 const [loading,setLoading]=useState(false);
 const [message,setMessage]=useState('');
 useEffect(()=>{if(!vacancyId&&vacancies[0]?.id)setVacancyId(vacancies[0].id)},[vacancies,vacancyId]);
 useEffect(()=>{if(!vacancyId)return;setLoading(true);fetch(`/api/vacancies/${vacancyId}/dialogue`).then(async r=>{const data=await r.json();if(!r.ok)throw new Error(data.error);setEnabled(data.enabled);setGreeting(data.greeting);setQuestions(data.questions?.length?data.questions:[
  'Расскажите о проекте, где ваша работа привела к измеримым заявкам или продажам. Какие показатели вы отслеживали?',
  'Пришлите, пожалуйста, ссылку на 2–3 примера креативов или презентаций, которые вы самостоятельно сделали в Figma.',
  'Как бы вы организовали вебинар для управляющих ресторанами: от идеи до обработки полученных лидов?',
  'Какие AI-инструменты вы используете в работе и как проверяете качество результата?',
  'Что вы сделали бы в первые 30 дней работы с нашими каналами?',
 ]);setStats(data.stats||{});setMessage('')}).catch(e=>setMessage(e.message||'Не удалось загрузить настройки')).finally(()=>setLoading(false))},[vacancyId]);
 const updateQuestion=(index:number,value:string)=>setQuestions(items=>items.map((item,i)=>i===index?value:item));
 const save=async()=>{if(!vacancyId)return;setLoading(true);setMessage('');try{const r=await fetch(`/api/vacancies/${vacancyId}/dialogue`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled,greeting,questions})});const data=await r.json();if(!r.ok)throw new Error(data.error);setEnabled(data.enabled);setMessage(data.enabled?'Автодиалог включён. Новые сообщения проверяются каждую минуту.':'Настройки сохранены, автодиалог выключен.')}catch(e){setMessage(e instanceof Error?e.message:'Не удалось сохранить')}finally{setLoading(false)}};
 const run=async()=>{setLoading(true);setMessage('Проверяем новые диалоги…');try{const r=await fetch('/api/dialogues/sync',{method:'POST'});const data=await r.json();if(!r.ok)throw new Error(data.error);setMessage(`Запущено: ${data.started||0}, продолжено: ${data.advanced||0}, завершено: ${data.completed||0}, ошибок: ${data.errors||0}`)}catch(e){setMessage(e instanceof Error?e.message:'Ошибка проверки диалогов')}finally{setLoading(false)}};
 if(!vacancies.length)return <section className="empty-state">Сначала синхронизируйте вакансии из hh.ru.</section>;
 return <section className="dialogue-settings"><div className="dialogue-top"><label className="criteria-vacancy">Вакансия<select value={vacancyId||''} onChange={e=>setVacancyId(Number(e.target.value))}>{vacancies.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label><label className="automation-toggle"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/><span></span><b>Автодиалог {enabled?'включён':'выключен'}</b></label></div><div className="dialogue-stats"><span><b>{stats.active||0}</b> ждут ответа</span><span><b>{stats.completed||0}</b> завершены</span><span><b>{stats.paused||0}</b> приостановлены</span></div><label className="dialogue-field">Приветствие<textarea rows={4} maxLength={1500} value={greeting} onChange={e=>setGreeting(e.target.value)}/></label><div className="question-list"><div className="section-head"><h3>Вопросы по порядку</h3><button className="ghost-action" onClick={()=>setQuestions(items=>[...items,''])}><Plus/>Добавить вопрос</button></div>{questions.map((question,index)=><div key={index}><b>{index+1}</b><textarea rows={3} maxLength={1000} value={question} onChange={e=>updateQuestion(index,e.target.value)}/><button className="remove-criterion" title="Удалить вопрос" onClick={()=>setQuestions(items=>items.filter((_,i)=>i!==index))}><X/></button></div>)}</div><div className="dialogue-warning"><b>Перед включением проверьте тексты.</b><p>После сохранения с включённым переключателем CRM начнёт писать максимум пяти новым кандидатам за цикл и будет проверять ответы раз в минуту.</p></div>{message&&<p className="criteria-message">{message}</p>}<div className="dialogue-actions"><button className="ghost-action" onClick={run} disabled={loading||!enabled}>Проверить сейчас</button><button className="primary" onClick={save} disabled={loading||!greeting.trim()||!questions.some(Boolean)}>{loading?'Подождите…':'Сохранить настройки'}</button></div></section>
}

function Criteria({vacancies,candidates,onScored}:{vacancies:VacancyOption[];candidates:Candidate[];onScored:()=>Promise<void>}){
 const [vacancyId,setVacancyId]=useState<number|undefined>();
 const [criteria,setCriteria]=useState<Criterion[]>([]);
 const [loading,setLoading]=useState(false);
 const [message,setMessage]=useState('');
 useEffect(()=>{if(!vacancyId&&vacancies[0]?.id)setVacancyId(vacancies[0].id)},[vacancies,vacancyId]);
 useEffect(()=>{if(!vacancyId)return;setLoading(true);setMessage('');fetch(`/api/vacancies/${vacancyId}/criteria`).then(async r=>{const data=await r.json();if(!r.ok)throw new Error(data.error);setCriteria(data.criteria?.length?data.criteria:[{name:'Профильный опыт',description:'Релевантный опыт для этой вакансии',weight:40,position:0},{name:'Ключевые навыки',description:'Совпадение навыков с требованиями вакансии',weight:35,position:1},{name:'Релевантность задач',description:'Сходство прошлых задач с будущей ролью',weight:25,position:2}])}).catch(e=>setMessage(e.message||'Не удалось загрузить критерии')).finally(()=>setLoading(false))},[vacancyId]);
 const total=criteria.reduce((sum,item)=>sum+item.weight,0);
 const selectedVacancy=vacancies.find(item=>item.id===vacancyId);
 const vacancyCandidates=candidates.filter(candidate=>candidate.vacancy===selectedVacancy?.name);
 const scoredCount=vacancyCandidates.filter(candidate=>candidate.factors.length>0).length;
 const update=(index:number,patch:Partial<Criterion>)=>setCriteria(items=>items.map((item,i)=>i===index?{...item,...patch}:item));
 const add=()=>setCriteria(items=>[...items,{name:'Новый критерий',description:'',weight:0,position:items.length}]);
 const remove=(index:number)=>setCriteria(items=>items.filter((_,i)=>i!==index));
 const save=async()=>{if(!vacancyId||total!==100)return;setLoading(true);setMessage('');try{const r=await fetch(`/api/vacancies/${vacancyId}/criteria`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({criteria})});const data=await r.json();if(!r.ok)throw new Error(data.error);setCriteria(data.criteria);setMessage('Критерии сохранены')}catch(e){setMessage(e instanceof Error?e.message:'Не удалось сохранить')}finally{setLoading(false)}};
 const score=async()=>{if(!vacancyId||total!==100)return;setLoading(true);setMessage('AI оценивает до 10 новых кандидатов. Это может занять несколько минут…');try{const saved=await fetch(`/api/vacancies/${vacancyId}/criteria`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({criteria})});const savedData=await saved.json();if(!saved.ok)throw new Error(savedData.error);setCriteria(savedData.criteria);const r=await fetch(`/api/vacancies/${vacancyId}/score`,{method:'POST'});const data=await r.json();if(!r.ok)throw new Error(data.error);if(data.scored){setMessage(`Готово: оценено кандидатов — ${data.scored}. Обновляем воронку…`);await onScored()}else setMessage(data.errors?.[0]?.error||'Новых кандидатов без оценки не найдено.')}catch(e){setMessage(e instanceof Error?e.message:'Не удалось запустить скоринг')}finally{setLoading(false)}};
 if(!vacancies.length)return <section className="criteria-page"><p>Сначала синхронизируйте активные вакансии из hh.ru.</p></section>;
 return <section className="criteria-page">
  <div className="criteria-title"><div><label className="criteria-vacancy">Вакансия<select value={vacancyId||''} onChange={e=>setVacancyId(Number(e.target.value))}>{vacancies.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label><p className={total===100?'total-ok':'total-error'}>Сумма весов: {total}% {total!==100&&'· должна быть 100%'}</p><p className="scoring-progress">Оценено: <b>{scoredCount}</b> из {vacancyCandidates.length}</p></div><div className="criteria-actions"><button className="ghost-action" onClick={add}><Plus/>Добавить</button><button className="ghost-action ai-score-action" onClick={score} disabled={loading||total!==100}><Sparkles/>Оценить следующие 10</button><button className="primary" onClick={save} disabled={loading||total!==100}>{loading?'Подождите…':'Сохранить'}</button></div></div>
  {criteria.map((item,i)=><div className="criterion" key={`${i}-${item.id||'new'}`}><span className="drag">⋮⋮</span><div className="criterion-fields"><label>Название критерия<input value={item.name} maxLength={120} onChange={e=>update(i,{name:e.target.value})}/></label><label>Описание для AI<textarea value={item.description} maxLength={1500} rows={3} onChange={e=>update(i,{description:e.target.value})}/><small>{item.description.length}/1500</small></label></div><input type="range" min="0" max="100" value={item.weight} onChange={e=>update(i,{weight:Number(e.target.value)})}/><strong>{item.weight}%</strong><button className="remove-criterion" title="Удалить критерий" onClick={()=>remove(i)}><X/></button></div>)}
  {message&&<p className="criteria-message">{message}</p>}<div className="ai-note"><Sparkles/><div><b>Как считается итоговый скор</b><p>AI оценивает только профессиональные данные резюме по заданным критериям, затем применяет веса. Чувствительные персональные признаки исключены. Оценка носит рекомендательный характер, финальное решение принимает рекрутер.</p></div></div>
 </section>
}
function CandidatePanel({candidate:c,close,move}:{candidate:Candidate;close:()=>void;move:(id:number,s:Stage)=>void}){return <div className="overlay" onClick={close}><aside className="drawer" onClick={e=>e.stopPropagation()}><div className="drawer-top"><span>Карточка кандидата</span><button className="icon" onClick={close}><X/></button></div><div className="person"><div className="avatar large" style={{background:c.color}}>{c.initials}</div><div><h2>{c.name}</h2><p>{c.role}</p></div><span className={'score big '+scoreTone(c.score)}>{c.score}</span></div><div className="facts"><span><small>Локация</small>{c.location}</span><span><small>Опыт</small>{c.experience}</span><span><small>Ожидания</small>{c.salary}</span></div><label className="stage-select">Этап<select value={c.stage} onChange={e=>move(c.id,e.target.value as Stage)}>{stages.map(s=><option key={s}>{s}</option>)}</select></label><div className="panel-section"><div className="section-head"><h3>AI-оценка</h3><Sparkles/></div>{c.factors.map(f=><div className="factor" key={f.label}><div><b>{f.label}</b><small>{f.note}</small></div><div className="bar"><i style={{width:f.score+'%'}}></i></div><strong>{f.score}</strong></div>)}</div><div className="panel-section"><div className="section-head"><h3>Диалог в hh.ru</h3><span className="connected">подключен</span></div><div className="message incoming">Анна, добрый день! Рассматриваете сейчас новые предложения?</div><div className="message outgoing">Здравствуйте! Да, особенно продуктовые команды с B2B-направлением.</div><button className="reply"><MessageSquareText/>Открыть переписку</button></div></aside></div>}
