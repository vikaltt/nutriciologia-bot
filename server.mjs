import express from 'express';
import http from 'http';
import { Bot } from 'grammy';
import cron from 'node-cron';
import 'dotenv/config';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const AI_MODEL = process.env.AI_MODEL || 'openai/gpt-3.5-turbo';

const bot = new Bot(BOT_TOKEN);

const openai = new OpenAI({
  apiKey: OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1'
});

const app = express();
app.use(express.json());

const DATA_DIR = './data';
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadData(filename) {
  const filePath = path.join(DATA_DIR, filename);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  return [];
}

function saveData(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

const profiles = loadData('profiles.json');
const surveys = loadData('surveys.json');
const nutritionPlans = loadData('nutrition_plans.json');
const checkIns = loadData('check_ins.json');

const userStates = new Map();

function findProfile(telegramId) {
  return profiles.find(p => p.telegram_id === telegramId);
}

function createProfile(telegramId, firstName) {
  const profile = {
    id: 'p' + Date.now(),
    telegram_id: telegramId,
    full_name: firstName,
    role: 'client',
    created: new Date().toISOString()
  };
  profiles.push(profile);
  saveData('profiles.json', profiles);
  return profile;
}

function findSurvey(clientId) {
  const clientProfile = profiles.find(p => p.id === clientId);
  if (!clientProfile) return null;
  return surveys.find(s => s.client_id === clientId);
}

function createSurvey(clientId, data) {
  const survey = {
    id: 's' + Date.now(),
    client_id: clientId,
    ...data,
    status: 'new',
    created: new Date().toISOString()
  };
  surveys.push(survey);
  saveData('surveys.json', surveys);
  return survey;
}

function createNutritionPlan(clientId, planData) {
  const plan = {
    id: 'np' + Date.now(),
    client_id: clientId,
    plan_data: planData,
    status: 'active',
    created: new Date().toISOString()
  };
  nutritionPlans.push(plan);
  saveData('nutrition_plans.json', nutritionPlans);
  return plan;
}

function createCheckIn(clientId, data) {
  const checkIn = {
    id: 'ci' + Date.now(),
    client_id: clientId,
    ...data,
    date: new Date().toISOString().split('T')[0]
  };
  checkIns.push(checkIn);
  saveData('check_ins.json', checkIns);
  return checkIn;
}

async function generateNutritionPlan(profile, survey) {
  const completion = await openai.chat.completions.create({
    model: AI_MODEL,
    messages: [{ role: 'user', content: `Создай план питания JSON для ${profile.full_name}. Цель: ${survey.goals}. Верни JSON с полями calories, protein, fat, carbs, meals (массив с name, time, options, calories).` }],
    max_tokens: 1000
  });
  
  try {
    return JSON.parse(completion.choices[0].message.content);
  } catch {
    return { calories: 2000, protein: 150, fat: 70, carbs: 250, meals: [{ name: 'Завтрак', time: '08:00', options: ['Овсянка'], calories: 400 }] };
  }
}

bot.command('start', async (ctx) => {
  const telegramId = ctx.from?.id.toString() || '';
  const firstName = ctx.from?.first_name || '';
  try {
    let profile = findProfile(telegramId);
    if (!profile) {
      profile = createProfile(telegramId, firstName);
    }
    await ctx.reply(`👋 Добро пожаловать, ${firstName}!\n\n/survey - анкета\n/plan - план питания\n/checkin - чек-ин\n/progress - прогресс`);
  } catch (e) {
    console.error(e);
    await ctx.reply('Ошибка. Попробуйте позже.');
  }
});

bot.command('survey', async (ctx) => {
  const userId = ctx.from?.id;
  const telegramId = ctx.from?.id.toString();
  userStates.set(userId, { step: 'goals', data: { telegramId } });
  await ctx.reply('📋 Анкета\n\n1️⃣ Цель? (Похудеть/Набрать/Поддержать/Здоровье)');
});

bot.command('plan', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  try {
    let profile = findProfile(telegramId);
    if (!profile) {
      await ctx.reply('Сначала /start');
      return;
    }
    
    const survey = findSurvey(profile.id);
    if (!survey) {
      await ctx.reply('Сначала /survey');
      return;
    }
    
    await ctx.reply('🔄 Генерирую план...');
    const planData = await generateNutritionPlan(profile, survey);
    createNutritionPlan(profile.id, planData);
    await ctx.reply(`✅ План: ${planData.calories}ккал, белки:${planData.protein}г, жиры:${planData.fat}г, углеводы:${planData.carbs}г`);
  } catch (e) {
    console.error(e);
    await ctx.reply('Ошибка. Попробуйте позже.');
  }
});

bot.command('checkin', async (ctx) => {
  const userId = ctx.from?.id;
  const telegramId = ctx.from?.id.toString();
  userStates.set(userId, { step: 'checkin_water', data: { telegramId } });
  await ctx.reply('📝 Чек-ин\n\n1️⃣ Вода (мл)?');
});

bot.command('progress', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  try {
    const profile = findProfile(telegramId);
    if (!profile) {
      await ctx.reply('Нет записей. /start');
      return;
    }
    
    const userCheckIns = checkIns.filter(ci => ci.client_id === profile.id).slice(-7);
    if (userCheckIns.length === 0) {
      await ctx.reply('Нет записей. /checkin');
      return;
    }
    
    let message = '📈 Прогресс за 7 дней:\n\n';
    for (const ci of userCheckIns) {
      message += `📅 ${ci.date}\n💧 Вода: ${ci.water_ml}мл\n`;
      if (ci.weight) message += `⚖️ Вес: ${ci.weight}кг\n`;
      message += '\n';
    }
    await ctx.reply(message);
  } catch (e) {
    console.error(e);
    await ctx.reply('Ошибка.');
  }
});

bot.on('message:text', async (ctx) => {
  const userId = ctx.from?.id;
  const state = userStates.get(userId);
  if (!state) {
    await ctx.reply('Команды: /start, /survey, /plan, /checkin, /progress');
    return;
  }
  
  const text = ctx.message.text;
  
  if (state.step === 'goals') {
    state.data.goals = text;
    state.step = 'restrictions';
    userStates.set(userId, state);
    await ctx.reply('2️⃣ Ограничения? (или "нет")');
  } else if (state.step === 'restrictions') {
    state.data.restrictions = text.toLowerCase() === 'нет' ? '' : text;
    state.step = 'budget';
    userStates.set(userId, state);
    await ctx.reply('3️⃣ Бюджет? (Низкий/Средний/Высокий)');
  } else if (state.step === 'budget') {
    state.data.budget = text;
    try {
      let profile = findProfile(state.data.telegramId);
      if (!profile) {
        profile = createProfile(state.data.telegramId, ctx.from?.first_name || 'User');
      }
      
      createSurvey(profile.id, {
        goals: state.data.goals,
        restrictions: state.data.restrictions,
        budget: state.data.budget
      });
      
      userStates.delete(userId);
      await ctx.reply('✅ Анкета сохранена!\n/plan - получить план');
    } catch (e) {
      console.error(e);
      await ctx.reply('Ошибка сохранения.');
    }
  } else if (state.step === 'checkin_water') {
    state.data.water = text;
    state.step = 'checkin_weight';
    userStates.set(userId, state);
    await ctx.reply('2️⃣ Вес (кг) или "нет"?');
  } else if (state.step === 'checkin_weight') {
    state.data.weight = text.toLowerCase() === 'нет' ? '' : text;
    state.step = 'checkin_food';
    userStates.set(userId, state);
    await ctx.reply('3️⃣ Ели вне плана? (или "нет")');
  } else if (state.step === 'checkin_food') {
    try {
      let profile = findProfile(state.data.telegramId);
      if (!profile) {
        profile = createProfile(state.data.telegramId, ctx.from?.first_name || 'User');
      }
      
      createCheckIn(profile.id, {
        water_ml: parseInt(state.data.water),
        weight: state.data.weight ? parseFloat(state.data.weight) : null,
        food_log: text.toLowerCase() === 'нет' ? '' : text
      });
      
      userStates.delete(userId);
      await ctx.reply('✅ Чек-ин сохранён!');
    } catch (e) {
      console.error(e);
      await ctx.reply('Ошибка.');
    }
  }
});

app.use('/bot', (req, res) => {
  bot.handleUpdate(req.body, res);
});

app.get('/', (req, res) => res.send('Nutriciologia Bot running'));

app.get('/admin', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Nutriciologia Admin</title>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
    h1 { color: #333; }
    h2 { color: #555; margin-top: 30px; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #4CAF50; color: white; font-weight: 600; }
    tr:hover { background: #f9f9f9; }
    .badge { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; }
    .badge-client { background: #e3f2fd; color: #1976d2; }
    .badge-nutritionist { background: #fff3e0; color: #f57c00; }
    .empty { color: #999; font-style: italic; }
    .stat { display: inline-block; background: #4CAF50; color: white; padding: 8px 16px; border-radius: 8px; margin-right: 10px; }
    .section { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
  </style>
</head>
<body>
  <h1>🍏 Nutriciologia Admin</h1>
  <div class="section">
    <span class="stat">👥 Профилей: ${profiles.length}</span>
    <span class="stat">📝 Анкет: ${surveys.length}</span>
    <span class="stat">📊 Чек-инов: ${checkIns.length}</span>
  </div>
  
  <div class="section">
    <h2>👥 Пользователи</h2>
    ${profiles.length === 0 ? '<p class="empty">Нет пользователей</p>' : `
    <table>
      <tr><th>ID</th><th>Имя</th><th>Telegram ID</th><th>Роль</th><th>Дата</th></tr>
      ${profiles.map(p => `<tr>
        <td>${p.id}</td>
        <td>${p.full_name}</td>
        <td>${p.telegram_id}</td>
        <td><span class="badge badge-${p.role}">${p.role}</span></td>
        <td>${new Date(p.created).toLocaleDateString('ru-RU')}</td>
      </tr>`).join('')}
    </table>`}
  </div>
  
  <div class="section">
    <h2>📝 Анкеты</h2>
    ${surveys.length === 0 ? '<p class="empty">Нет анкет</p>' : `
    <table>
      <tr><th>ID</th><th>Пользователь</th><th>Цель</th><th>Ограничения</th><th>Бюджет</th><th>Дата</th></tr>
      ${surveys.map(s => {
        const profile = profiles.find(p => p.id === s.client_id);
        return `<tr>
          <td>${s.id}</td>
          <td>${profile ? profile.full_name : '?'}</td>
          <td>${s.goals || '-'}</td>
          <td>${s.restrictions || '-'}</td>
          <td>${s.budget || '-'}</td>
          <td>${new Date(s.created).toLocaleDateString('ru-RU')}</td>
        </tr>`;
      }).join('')}
    </table>`}
  </div>
  
  <div class="section">
    <h2>📊 Последние чек-ины</h2>
    ${checkIns.length === 0 ? '<p class="empty">Нет чек-инов</p>' : `
    <table>
      <tr><th>ID</th><th>Пользователь</th><th>Вода (мл)</th><th>Вес (кг)</th><th>Питание</th><th>Дата</th></tr>
      ${checkIns.map(ci => {
        const profile = profiles.find(p => p.id === ci.client_id);
        return `<tr>
          <td>${ci.id}</td>
          <td>${profile ? profile.full_name : '?'}</td>
          <td>${ci.water_ml}</td>
          <td>${ci.weight || '-'}</td>
          <td>${ci.food_log || '-'}</td>
          <td>${ci.date}</td>
        </tr>`;
      }).join('')}
    </table>`}
  </div>
</body>
</html>`);
});

app.get('/admin/profiles', (req, res) => {
  res.json({ profiles, surveys, checkIns: checkIns.slice(-20) });
});

app.get('/admin/plans', (req, res) => {
  res.json(nutritionPlans);
});

const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server on port ${PORT}`);
  
  if (WEBHOOK_URL) {
    await bot.api.setWebhook(WEBHOOK_URL);
    console.log(`Webhook: ${WEBHOOK_URL}`);
  } else {
    await bot.start();
    console.log('Long polling');
  }
  
  cron.schedule('0 9 * * *', () => console.log('🌅 Morning'));
  cron.schedule('0 21 * * *', () => console.log('🌙 Evening'));
});