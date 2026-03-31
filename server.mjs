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
    
    showMainMenu(ctx, firstName);
  } catch (e) {
    console.error(e);
    await ctx.reply('Ошибка. Попробуйте позже.');
  }
});

function showMainMenu(ctx, firstName) {
  const keyboard = {
    keyboard: [
      ['📋 Заполнить анкету'],
      ['🍽️ Получить план питания'],
      ['📝 Чек-ин'],
      ['📊 Мой прогресс']
    ],
    resize_keyboard: true
  };
  
  ctx.reply(`👋 Привет, ${firstName}!

Я помогу тебе составить персональный план питания и отслеживать прогресс.

Выбери действие:`, {
    reply_markup: keyboard
  });
}

bot.on('message:text', async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from?.id;
  const telegramId = ctx.from?.id.toString();
  
  if (text === '📋 Заполнить анкету') {
    await ctx.deleteMessage();
    await bot.command('survey')(ctx);
    return;
  }
  
  if (text === '🍽️ Получить план питания') {
    await ctx.deleteMessage();
    await bot.command('plan')(ctx);
    return;
  }
  
  if (text === '📝 Чек-ин') {
    await ctx.deleteMessage();
    await bot.command('checkin')(ctx);
    return;
  }
  
  if (text === '📊 Мой прогресс') {
    await ctx.deleteMessage();
    await bot.command('progress')(ctx);
    return;
  }
  
  const state = userStates.get(userId);
  
  if (!state) {
    showMainMenu(ctx, ctx.from?.first_name || 'друг');
    return;
  }
  
  // ... rest of text handling
});

bot.command('survey', async (ctx) => {
  const userId = ctx.from?.id;
  const telegramId = ctx.from?.id.toString();
  const firstName = ctx.from?.first_name || 'друг';
  
  userStates.set(userId, { step: 'goals', data: { telegramId } });
  
  const keyboard = {
    inline_keyboard: [
      [{ text: '🎯 Похудеть', callback_data: 'goal_Похудеть' }],
      [{ text: '💪 Набрать массу', callback_data: 'goal_Набрать массу' }],
      [{ text: '⚖️ Поддержать вес', callback_data: 'goal_Поддержать вес' }],
      [{ text: '❤️ Улучшить здоровье', callback_data: 'goal_Улучшить здоровье' }]
    ]
  };
  
  await ctx.reply(`📋 Привет, ${firstName}! Давай заполним анкету.

❓ **Какова твоя основная цель?**`, {
    reply_markup: keyboard
  });
});

bot.command('plan', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  try {
    let profile = findProfile(telegramId);
    if (!profile) {
      await ctx.reply('Сначала нажми /start чтобы зарегистрироваться');
      return;
    }
    
    const survey = findSurvey(profile.id);
    if (!survey) {
      const keyboard = {
        inline_keyboard: [
          [{ text: '📋 Заполнить анкету', callback_data: 'cmd_survey' }]
        ]
      };
      await ctx.reply('Сначала нужно заполнить анкету!', {
        reply_markup: keyboard
      });
      return;
    }
    
    await ctx.reply('🔄 Генерирую твой персональный план питания...\n\nЭто займёт около минуты...');
    const planData = await generateNutritionPlan(profile, survey);
    createNutritionPlan(profile.id, planData);
    
    let response = `✅ **ПЛАН ПИТАНИЯ СОЗДАН!**\n\n`;
    response += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    response += `📊 **СУТОЧНАЯ НОРМА:**\n`;
    response += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    response += `🔥 Калории: ${planData.calories} ккал\n`;
    response += `🥩 Белки: ${planData.protein}г\n`;
    response += `🥑 Жиры: ${planData.fat}г\n`;
    response += `🍚 Углеводы: ${planData.carbs}г\n\n`;
    
    response += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    response += `🍽️ **ПРИЁМЫ ПИЩИ:**\n`;
    response += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    
    if (planData.meals && planData.meals.length > 0) {
      for (const meal of planData.meals) {
        response += `\n⏰ ${meal.time} — ${meal.name}\n`;
        response += `   Калории: ${meal.calories}\n`;
        if (meal.options && meal.options.length > 0) {
          response += `   Варианты: ${meal.options.join(', ')}\n`;
        }
      }
    }
    
    response += `\n━━━━━━━━━━━━━━━━━━━━━━\n`;
    response += `📝 **ОБЩИЕ РЕКОМЕНДАЦИИ:**\n`;
    response += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    response += `• Пей 2-3 литра воды в день\n`;
    response += `• Ешь 4-5 раз в день небольшими порциями\n`;
    response += `• Последний приём пищи за 3 часа до сна\n`;
    response += `• Больше овощей и фруктов\n`;
    response += `• Ограничь сладкое и жирное\n`;
    response += `• Больше двигайся - минимум 30 мин в день\n`;
    
    await ctx.reply(response, { parse_mode: 'Markdown' });
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '📝 Сделать чек-ин', callback_data: 'cmd_checkin' }],
        [{ text: '📊 Мой прогресс', callback_data: 'cmd_progress' }]
      ]
    };
    await ctx.reply('Что делаем дальше?', { reply_markup: keyboard });
    
  } catch (e) {
    console.error(e);
    await ctx.reply('Ошибка. Попробуйте позже.');
  }
});

bot.command('checkin', async (ctx) => {
  const userId = ctx.from?.id;
  const telegramId = ctx.from?.id.toString();
  
  userStates.set(userId, { step: 'checkin_water', data: { telegramId } });
  
  const keyboard = {
    inline_keyboard: [
      [{ text: '💧 1000 мл', callback_data: 'water_1000' }],
      [{ text: '💧 1500 мл', callback_data: 'water_1500' }],
      [{ text: '💧 2000 мл', callback_data: 'water_2000' }],
      [{ text: '💧 Другое', callback_data: 'water_custom' }]
    ]
  };
  
  await ctx.reply('📝 **ЧЕК-ИН**\n\nСколько воды ты выпил сегодня?', {
    reply_markup: keyboard,
    parse_mode: 'Markdown'
  });
});

bot.command('progress', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  try {
    const profile = findProfile(telegramId);
    if (!profile) {
      await ctx.reply('Нет записей. Начни с /start');
      return;
    }
    
    const userCheckIns = checkIns.filter(ci => ci.client_id === profile.id).slice(-7);
    if (userCheckIns.length === 0) {
      await ctx.reply('Пока нет записей. Сделай первый чек-ин: /checkin');
      return;
    }
    
    let message = `📊 **ТВОЙ ПРОГРЕСС**\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    
    for (const ci of userCheckIns) {
      message += `📅 ${ci.date}\n`;
      message += `💧 Вода: ${ci.water_ml}мл`;
      if (ci.weight) message += ` | ⚖️ Вес: ${ci.weight}кг`;
      message += `\n\n`;
    }
    
    message += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    const avgWater = Math.round(userCheckIns.reduce((sum, ci) => sum + ci.water_ml, 0) / userCheckIns.length);
    message += `📈 Среднее потребление воды: ${avgWater}мл/день`;
    
    await ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error(e);
    await ctx.reply('Ошибка.');
  }
});

bot.on('callback_query', async (ctx) => {
  const callbackData = ctx.callbackQuery.data;
  const userId = ctx.callbackQuery.from.id;
  const telegramId = userId.toString();
  
  await ctx.answerCallbackQuery();
  
  if (callbackData.startsWith('goal_')) {
    const goal = callbackData.replace('goal_', '');
    const state = userStates.get(userId) || { step: '', data: { telegramId } };
    state.step = 'restrictions';
    state.data.goals = goal;
    userStates.set(userId, state);
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '✅ Нет ограничений', callback_data: 'restrict_none' }],
        [{ text: '🥛 Аллергия на молоко', callback_data: 'restrict_молоко' }],
        [{ text: '🥜 Аллергия на орехи', callback_data: 'restrict_орехи' }],
        [{ text: '🥗 Вегетарианец', callback_data: 'restrict_вегетарианец' }],
        [{ text: '🍖 Веган', callback_data: 'restrict_веган' }]
      ]
    };
    
    await ctx.editMessageText(`📋 **ОТЛИЧНО!**

🎯 Цель: *${goal}*

❓ Есть ли у тебя ограничения в питании?`, {
      reply_markup: keyboard,
      parse_mode: 'Markdown'
    });
    
  } else if (callbackData.startsWith('restrict_')) {
    const restrictions = callbackData.replace('restrict_', '');
    const state = userStates.get(userId);
    if (!state) return;
    
    state.step = 'budget';
    state.data.restrictions = restrictions === 'none' ? 'Нет' : restrictions;
    userStates.set(userId, state);
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '💰 Низкий', callback_data: 'budget_Низкий' }],
        [{ text: '💰💰 Средний', callback_data:budget_Средний' }],
        [{ text: '💰💰💰 Высокий', callback_data: 'budget_Высокий' }]
      ]
    };
    
    await ctx.editMessageText(`📋 **ПРОДОЛЖАЕМ**

❓ Какой у тебя бюджет на питание в месяц?`, {
      reply_markup: keyboard,
      parse_mode: 'Markdown'
    });
    
  } else if (callbackData.startsWith('budget_')) {
    const budget = callbackData.replace('budget_', '');
    const state = userStates.get(userId);
    if (!state) return;
    
    try {
      let profile = findProfile(telegramId);
      if (!profile) {
        profile = createProfile(telegramId, ctx.callbackQuery.from.first_name || 'User');
      }
      
      createSurvey(profile.id, {
        goals: state.data.goals,
        restrictions: state.data.restrictions,
        budget: budget
      });
      
      userStates.delete(userId);
      
      await ctx.editMessageText(`✅ **АНКЕТА СОХРАНЕНА!**

📊 Твои данные:
• Цель: ${state.data.goals}
• Ограничения: ${state.data.restrictions}
• Бюджет: ${budget}

🎯 Теперь можешь получить план питания!`, {
        parse_mode: 'Markdown'
      });
      
      const keyboard = {
        inline_keyboard: [
          [{ text: '🍽️ Получить план питания', callback_data: 'cmd_plan' }]
        ]
      };
      await ctx.reply('Нажми кнопку ниже:', { reply_markup: keyboard });
      
    } catch (e) {
      console.error(e);
      await ctx.editMessageText('Ошибка сохранения. Попробуй позже.');
    }
    
  } else if (callbackData.startsWith('water_')) {
    const water = callbackData.replace('water_', '');
    const state = userStates.get(userId) || { step: '', data: { telegramId } };
    
    if (water === 'custom') {
      state.step = 'checkin_water';
      userStates.set(userId, state);
      await ctx.editMessageText('📝 Введи количество воды в миллилитрах:\n\nНапример: 1500');
    } else {
      state.step = 'checkin_weight';
      state.data.water = water;
      userStates.set(userId, state);
      
      const keyboard = {
        inline_keyboard: [
          [{ text: '⚖️ Указать вес', callback_data: 'weight_yes' }],
          [{ text: '❌ Пропустить', callback_data: 'weight_no' }]
        ]
      };
      
      await ctx.editMessageText(`💧 Вода: ${water}мл\n\n❓ Хочешь указать сегодняшний вес?`, {
        reply_markup: keyboard
      });
    }
    
  } else if (callbackData.startsWith('weight_')) {
    const state = userStates.get(userId);
    if (!state) return;
    
    if (callbackData === 'weight_yes') {
      await ctx.editMessageText('Введи свой вес в кг:\n\nНапример: 75');
    } else {
      state.step = 'checkin_food';
      userStates.set(userId, state);
      
      const keyboard = {
        inline_keyboard: [
          [{ text: '✅ Всё по плану', callback_data: 'food_none' }],
          [{ text: '🍔 Ел(а) вне плана', callback_data: 'food_custom' }]
        ]
      };
      
      await ctx.editMessageText('❓ Как прошёл день с питанием?', {
        reply_markup: keyboard
      });
    }
    
  } else if (callbackData.startsWith('food_')) {
    const state = userStates.get(userId);
    if (!state) return;
    
    const food = callbackData.replace('food_', '');
    
    try {
      let profile = findProfile(telegramId);
      if (!profile) {
        profile = createProfile(telegramId, ctx.callbackQuery.from.first_name || 'User');
      }
      
      createCheckIn(profile.id, {
        water_ml: parseInt(state.data.water),
        weight: state.data.weight ? parseFloat(state.data.weight) : null,
        food_log: food === 'none' ? '' : 'Ел(а) вне плана'
      });
      
      userStates.delete(userId);
      
      await ctx.editMessageText(`✅ **ЧЕК-ИН СОХРАНЕН!**

📊 Сегодня:
💧 Вода: ${state.data.water}мл${state.data.weight ? '\n⚖️ Вес: ' + state.data.weight + 'кг' : ''}

Продолжай в том же духе! 💪`, {
        parse_mode: 'Markdown'
      });
      
    } catch (e) {
      console.error(e);
      await ctx.editMessageText('Ошибка. Попробуй позже.');
    }
    
  } else if (callbackData === 'cmd_survey') {
    ctx.callbackQuery.message = null;
    await ctx.deleteMessage();
    await bot.api.sendMessage(userId, 'Начинаю анкету...');
    await bot.command('survey')(ctx);
  } else if (callbackData === 'cmd_checkin') {
    await ctx.deleteMessage();
    await bot.command('checkin')(ctx);
  } else if (callbackData === 'cmd_progress') {
    await ctx.deleteMessage();
    await bot.command('progress')(ctx);
  } else if (callbackData === 'cmd_plan') {
    await ctx.deleteMessage();
    await bot.command('plan')(ctx);
  }
});

bot.on('message:text', async (ctx) => {
  const userId = ctx.from?.id;
  const telegramId = ctx.from?.id.toString();
  const text = ctx.message.text;
  const state = userStates.get(userId);
  
  if (!state) {
    showMainMenu(ctx, ctx.from?.first_name || 'друг');
    return;
  }
  
  if (state.step === 'checkin_water' && text.match(/^\d+$/)) {
    state.data.water = text;
    state.step = 'checkin_weight';
    userStates.set(userId, state);
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '⚖️ Указать вес', callback_data: 'weight_yes' }],
        [{ text: '❌ Пропустить', callback_data: 'weight_no' }]
      ]
    };
    
    await ctx.reply(`💧 Вода: ${text}мл\n\n❓ Хочешь указать сегодняшний вес?`, { reply_markup: keyboard });
    return;
  }
  
  if (state.step === 'checkin_weight' && text.match(/^\d+(\.\d+)?$/)) {
    state.data.weight = text;
    state.step = 'checkin_food';
    userStates.set(userId, state);
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '✅ Всё по плану', callback_data: 'food_none' }],
        [{ text: '🍔 Ел(а) вне плана', callback_data: 'food_custom' }]
      ]
    };
    
    await ctx.reply('❓ Как прошёл день с питанием?', { reply_markup: keyboard });
    return;
  }
  
  if (state.step === 'checkin_weight' && text.toLowerCase() === 'нет') {
    state.data.weight = '';
    state.step = 'checkin_food';
    userStates.set(userId, state);
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '✅ Всё по плану', callback_data: 'food_none' }],
        [{ text: '🍔 Ел(а) вне плана', callback_data: 'food_custom' }]
      ]
    };
    
    await ctx.reply('❓ Как прошёл день с питанием?', { reply_markup: keyboard });
    return;
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