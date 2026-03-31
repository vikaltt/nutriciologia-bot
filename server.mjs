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
    model: 'openai/gpt-3.5-turbo',
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

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'nutriciologia-admin';

app.get('/admin/profiles', (req, res) => {
  const secret = req.query.secret || req.headers['x-admin-secret'];
  if (secret !== ADMIN_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.json({ profiles, surveys, checkIns: checkIns.slice(-20) });
});

app.get('/admin/plans', (req, res) => {
  const secret = req.query.secret || req.headers['x-admin-secret'];
  if (secret !== ADMIN_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
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