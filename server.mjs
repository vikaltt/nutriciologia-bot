import express from 'express';
import http from 'http';
import { Bot } from 'grammy';
import cron from 'node-cron';
import 'dotenv/config';
import PocketBase from 'pocketbase';
import OpenAI from 'openai';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PB_URL = process.env.POCKETBASE_URL || 'http://localhost:8090';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';

const pb = new PocketBase(PB_URL);
const bot = new Bot(BOT_TOKEN);

const openai = new OpenAI({
  apiKey: OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1'
});

const app = express();
app.use(express.json());

const userStates = new Map();

async function getOrCreateProfile(telegramId, firstName) {
  const users = await pb.collection('profiles').getList(1, 1, {
    filter: `telegram_id = "${telegramId}"`
  });
  if (users.items.length === 0) {
    return await pb.collection('profiles').create({
      telegram_id: telegramId,
      full_name: firstName,
      role: 'client'
    });
  }
  return users.items[0];
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
    await getOrCreateProfile(telegramId, firstName);
    await ctx.reply(`👋 Добро пожаловать, ${firstName}!\n\n/survey - анкета\n/plan - план питания\n/checkin - чек-ин\n/progress - прогресс`);
  } catch (e) {
    await ctx.reply('Ошибка. Попробуйте позже.');
  }
});

bot.command('survey', async (ctx) => {
  const userId = ctx.from?.id;
  userStates.set(userId, { step: 'goals', data: { telegramId: ctx.from?.id.toString() } });
  await ctx.reply('📋 Анкета\n\n1️⃣ Цель? (Похудеть/Набрать/Поддержать/Здоровье)');
});

bot.command('plan', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  try {
    const profile = await getOrCreateProfile(telegramId, ctx.from?.first_name);
    const surveys = await pb.collection('surveys').getList(1, 1, { filter: `client_id = "${profile.id}"`, sort: '-created' });
    if (surveys.items.length === 0) {
      await ctx.reply('Сначала /survey');
      return;
    }
    await ctx.reply('🔄 Генерирую план...');
    const planData = await generateNutritionPlan(profile, surveys.items[0]);
    await pb.collection('nutrition_plans').create({ client_id: profile.id, plan_data: planData, status: 'active' });
    await ctx.reply(`✅ План: ${planData.calories}ккал, белки:${planData.protein}г, жиры:${planData.fat}г, углеводы:${planData.carbs}г`);
  } catch (e) {
    console.error(e);
    await ctx.reply('Ошибка. Попробуйте позже.');
  }
});

bot.command('checkin', async (ctx) => {
  const userId = ctx.from?.id;
  userStates.set(userId, { step: 'checkin_water', data: { telegramId: ctx.from?.id.toString() } });
  await ctx.reply('📝 Чек-ин\n\n1️⃣ Вода (мл)?');
});

bot.command('progress', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  try {
    const profile = await getOrCreateProfile(telegramId, ctx.from?.first_name);
    const checkIns = await pb.collection('check_ins').getList(1, 7, { filter: `client_id = "${profile.id}"`, sort: '-date' });
    if (checkIns.items.length === 0) {
      await ctx.reply('Нет записей. /checkin');
      return;
    }
    await ctx.reply('📈 Прогресс за 7 дней:\n' + checkIns.items.map(ci => `${ci.date}: ${ci.water_ml}мл`).join('\n'));
  } catch (e) {
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
      const profile = await getOrCreateProfile(state.data.telegramId, ctx.from?.first_name);
      await pb.collection('surveys').create({
        client_id: profile.id,
        goals: state.data.goals,
        restrictions: state.data.restrictions,
        budget: state.data.budget,
        status: 'new'
      });
      userStates.delete(userId);
      await ctx.reply('✅ Анкета сохранена!\n/plan - получить план');
    } catch (e) {
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
      const profile = await getOrCreateProfile(state.data.telegramId, ctx.from?.first_name);
      await pb.collection('check_ins').create({
        client_id: profile.id,
        water_ml: parseInt(state.data.water),
        weight: state.data.weight ? parseFloat(state.data.weight) : null,
        food_log: text.toLowerCase() === 'нет' ? '' : text,
        date: new Date().toISOString().split('T')[0]
      });
      userStates.delete(userId);
      await ctx.reply('✅ Чек-ин сохранён!');
    } catch (e) {
      await ctx.reply('Ошибка.');
    }
  }
});

app.use('/bot', (req, res) => {
  bot.handleUpdate(req.body, res);
});

app.get('/', (req, res) => res.send('Bot running'));

const server = http.createServer(app);
const PORT = 3000;

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