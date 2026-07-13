const db = require('./db');

async function insertTestTrades() {
  const chatId = 5703926806;
  const wallet = '0x1234567890123456789012345678901234567890';
  
  try {
    await db.recordTrade(
      chatId,
      wallet,
      'btc-up-or-down-daily-1783699200',
      'BTC Up or Down - Daily',
      'YES',
      100.00,
      0.65,
      153.85,
      null
    );
    
    await db.recordTrade(
      chatId,
      wallet,
      'eth-up-or-down-5-min-1783727700',
      'ETH Up or Down - 5 Min',
      'NO',
      50.00,
      0.28,
      178.57,
      null
    );
    
    await db.recordTrade(
      chatId,
      wallet,
      'sol-up-or-down-hourly-1783724400',
      'SOL Up or Down - Hourly',
      'YES',
      75.00,
      0.52,
      144.23,
      null
    );
    
    console.log('✅ Test trades inserted');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

insertTestTrades();