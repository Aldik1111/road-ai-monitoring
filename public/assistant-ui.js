function createAssistantUI({getUser, getLanguage, escape, redraw}) {
  const words={
    ru:{title:'Помощник по дорогам',intro:'Спросите о поездках, проверках и ремонте',notice:'В OpenAI отправляются ваш вопрос, последние сообщения, сводка и до 12 последних записей каждого типа. Видео, файлы и GPS-треки не отправляются. Ответы могут содержать ошибки. Помощник не изменяет данные.',shared:'История общая для пользователей одной учётной записи и хранится на сервере.',ready:'OpenAI подключён',off:'Добавьте OPENAI_API_KEY в .env сервера и перезапустите приложение.',remaining:'Осталось запросов сегодня (UTC)',question:'Ваш вопрос',placeholder:'Например: какие задания требуют внимания?',send:'Отправить',thinking:'Готовлю ответ…',you:'Вы',assistant:'Road AI',empty:'Начните с вопроса или выберите пример.',suggestions:['Кратко опиши текущую ситуацию по дорогам','Как загрузить видео и GPS?','Как пройти путь от проверки до закрытия ремонта?'],errors:{ASSISTANT_NOT_CONFIGURED:'Ключ OpenAI не настроен на сервере.',ASSISTANT_KEY:'OpenAI отклонил ключ. Проверьте ключ и его права на сервере.',ASSISTANT_QUOTA:'OpenAI сообщает об исчерпанной квоте. Проверьте баланс и лимиты проекта.',ASSISTANT_MODEL:'Выбранная модель недоступна для проекта OpenAI.',ASSISTANT_RATE:'Слишком много запросов. Подождите минуту.',ASSISTANT_LIMIT:'Дневной лимит запросов исчерпан. Он обновится в 00:00 UTC.',ASSISTANT_BUSY:'Для этой учётной записи уже готовится ответ.',ASSISTANT_TIMEOUT:'OpenAI не ответил вовремя. Можно отправить вопрос ещё раз.',ASSISTANT_PROVIDER:'Не удалось получить ответ OpenAI. Проверьте подключение сервера.',ASSISTANT_INCOMPLETE:'Ответ модели не завершён. Попробуйте задать более короткий вопрос.',ASSISTANT_INTERRUPTED:'Сервер был перезапущен во время запроса. Отправьте вопрос заново.',UNAUTHORIZED:'Войдите в приложение заново.',NETWORK:'Нет связи с сервером. Повторите отправку.',INVALID_INPUT:'Введите вопрос длиной до 2000 символов.'}},
    kk:{title:'Жолдар жөніндегі көмекші',intro:'Сапарлар, тексеру және жөндеу туралы сұраңыз',notice:'OpenAI-ға сұрағыңыз, соңғы хабарламалар, жиынтық және әр түрдегі соңғы 12 жазбаға дейін жіберіледі. Бейне, файлдар және GPS-тректер жіберілмейді. Жауапта қате болуы мүмкін. Көмекші деректерді өзгертпейді.',shared:'Тарих бір тіркелгіні пайдаланатын адамдарға ортақ және серверде сақталады.',ready:'OpenAI қосылған',off:'Сервердің .env файлына OPENAI_API_KEY қосып, қолданбаны қайта іске қосыңыз.',remaining:'Бүгін қалған сұраулар (UTC)',question:'Сұрағыңыз',placeholder:'Мысалы: қандай тапсырмаларға назар аудару керек?',send:'Жіберу',thinking:'Жауап дайындалуда…',you:'Сіз',assistant:'Road AI',empty:'Сұрақ жазыңыз немесе мысалды таңдаңыз.',suggestions:['Жолдардың қазіргі жағдайын қысқаша сипатта','Бейне мен GPS-ті қалай жүктеуге болады?','Тексеруден жөндеуді жабуға дейінгі қадамдарды түсіндір'],errors:{ASSISTANT_NOT_CONFIGURED:'Серверде OpenAI кілті орнатылмаған.',ASSISTANT_KEY:'OpenAI кілтті қабылдамады. Сервердегі кілт пен рұқсаттарды тексеріңіз.',ASSISTANT_QUOTA:'OpenAI квотасы таусылған. Баланс пен жоба шектеулерін тексеріңіз.',ASSISTANT_MODEL:'Таңдалған модель OpenAI жобасына қолжетімсіз.',ASSISTANT_RATE:'Сұрау тым көп. Бір минут күтіңіз.',ASSISTANT_LIMIT:'Күндік сұрау шегі бітті. Шек UTC бойынша 00:00-де жаңарады.',ASSISTANT_BUSY:'Осы тіркелгі үшін жауап дайындалып жатыр.',ASSISTANT_TIMEOUT:'OpenAI уақытында жауап бермеді. Қайта жіберуге болады.',ASSISTANT_PROVIDER:'OpenAI жауабын алу мүмкін болмады. Сервер байланысын тексеріңіз.',ASSISTANT_INCOMPLETE:'Модель жауабы аяқталмады. Қысқарақ сұрақ қойып көріңіз.',ASSISTANT_INTERRUPTED:'Сұрау кезінде сервер қайта іске қосылды. Қайта жіберіңіз.',UNAUTHORIZED:'Қолданбаға қайта кіріңіз.',NETWORK:'Сервермен байланыс жоқ. Қайта жіберіңіз.',INVALID_INPUT:'2000 таңбадан аспайтын сұрақ жазыңыз.'}}
  };
  let data=null, pending=false, error='', draft='', request=null, epoch=0;
  const text=()=>words[getLanguage()] || words.kk;
  async function call(options) {
    let response;
    try {response=await fetch('/api/assistant',{...options,signal:AbortSignal.timeout(60000)});} catch {throw new Error('NETWORK');}
    const result=await response.json().catch(()=>{throw new Error('NETWORK');});
    if(!response.ok) throw new Error(result.code || 'NETWORK');
    return result;
  }
  async function load() {
    const version=epoch;
    try {const result=await call();if(version===epoch){data=result;error='';}}
    catch(e){if(version===epoch)error=e.message;}
  }
  function view() {
    const w=text(), disabled=pending || !data?.configured || data.remaining===0;
    return `<section class="panel assistant-panel"><div class="row"><h2>${w.title}</h2><span class="badge">${escape(data?.model || 'OpenAI')}</span></div><p class="muted">${w.intro}</p><p class="assistant-notice">${w.notice}</p><small>${w.shared}</small><p>${data?.configured?w.ready:w.off}</p>${data?`<small>${w.remaining}: ${data.remaining} / ${data.dailyLimit}</small>`:''}<div class="assistant-messages" role="log" aria-label="${w.title}">${data?.history.length?data.history.map(x=>`<article class="assistant-message question"><b>${w.you}</b><p>${escape(x.question)}</p></article><article class="assistant-message"><b>${w.assistant}</b><p>${escape(x.answer)}</p></article>`).join(''):`<p class="muted">${w.empty}</p>`}${pending?`<p role="status">${w.thinking}</p>`:''}</div><div class="actions">${w.suggestions.map((s,i)=>`<button type="button" data-chat-prompt="${i}" ${disabled?'disabled':''}>${s}</button>`).join('')}</div><form id="assistant-form"><label>${w.question}<textarea id="assistant-question" name="question" maxlength="2000" rows="3" required placeholder="${w.placeholder}" ${pending?'disabled':''}>${escape(draft)}</textarea></label><p class="error" role="alert">${escape(error?(w.errors[error] || w.errors.ASSISTANT_PROVIDER):'')}</p><button class="primary" ${disabled?'disabled':''}>${pending?w.thinking:w.send}</button></form></section>`;
  }
  async function send(question) {
    if(pending || !getUser() || !question.trim())return;
    const version=epoch, language=getLanguage(); draft=question;
    if(!request || request.question!==question || request.language!==language)request={question,language,key:crypto.randomUUID()};
    pending=true;error='';redraw();
    try {
      const answer=await call({method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':request.key},body:JSON.stringify({question,language})});
      if(version!==epoch)return;
      data.history.push(answer);data.remaining=Math.max(0,data.remaining-1);draft='';request=null;
    } catch(e) {
      if(version!==epoch)return;
      error=e.message;
      // A transport retry reuses the key to avoid charging twice for a lost reply.
      if(error!=='NETWORK' && error!=='ASSISTANT_BUSY')request=null;
    } finally {
      if(version===epoch){
        const previousError=error;
        await load();
        if(version===epoch){error=previousError || error;pending=false;redraw();}
      }
    }
  }
  document.addEventListener('input',e=>{if(e.target.id==='assistant-question')draft=e.target.value;});
  document.addEventListener('submit',e=>{if(e.target.id==='assistant-form'){e.preventDefault();send(new FormData(e.target).get('question') || '');}});
  document.addEventListener('click',e=>{const button=e.target.closest('[data-chat-prompt]');if(button)send(text().suggestions[Number(button.dataset.chatPrompt)]);});
  return {load,view,reset(){epoch++;data=null;pending=false;error='';draft='';request=null;}};
}
