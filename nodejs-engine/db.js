const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('[ZeroDrift] Database pool error:', err);
});

// Intialize Database

async function initializeDatabase() {
  const client = await pool.connect();
  try {
    console.log('[ZeroDrift] Initializing database schema...');

    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT UNIQUE NOT NULL,
        wallet_address VARCHAR(42),
        subscribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_trade_at TIMESTAMP,
        alerts_this_hour INTEGER DEFAULT 0,
        hour_window_start TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Seen headlines table
    await client.query(`
      CREATE TABLE IF NOT EXISTS seen_headlines (
        id SERIAL PRIMARY KEY,
        title TEXT UNIQUE NOT NULL,
        link TEXT,
        pub_date TIMESTAMP,
        seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Executed trades table
    await client.query(`
      CREATE TABLE IF NOT EXISTS executed_trades (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL REFERENCES users(chat_id) ON DELETE CASCADE,
        wallet_address VARCHAR(42),
        market_slug VARCHAR(255),
        market_title TEXT,
        side VARCHAR(10),
        amount_usdc DECIMAL(20, 6),
        estimated_price DECIMAL(10, 8),
        estimated_shares DECIMAL(20, 8),
        tx_hash VARCHAR(66),
        status VARCHAR(50) DEFAULT 'pending',
        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create indexes
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_chat_id ON users(chat_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet_address);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_trades_chat_id ON executed_trades(chat_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_trades_wallet ON executed_trades(wallet_address);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_headlines_title ON seen_headlines(title);`);

    console.log('[ZeroDrift] Database schema initialized');
  } catch (err) {
    console.error('[ZeroDrift] Database initialization error:', err);
    throw err;
  } finally {
    client.release();
  }
}

// User Queries

async function getUser(chatId) {
  const numericChatId = typeof chatId === 'string' ? parseInt(chatId, 10) : chatId;
  const result = await pool.query('SELECT * FROM users WHERE chat_id = $1', [numericChatId]);
  return result.rows[0] || null;
}

async function createUser(chatId) {
  const numericChatId = typeof chatId === 'string' ? parseInt(chatId, 10) : chatId;
  const result = await pool.query(
    'INSERT INTO users (chat_id, subscribed_at, hour_window_start) VALUES ($1, NOW(), NOW()) RETURNING *',
    [numericChatId]
  );
  return result.rows[0];
}

async function updateUserWallet(chatId, walletAddress) {
  const numericChatId = typeof chatId === 'string' ? parseInt(chatId, 10) : chatId;
  const result = await pool.query(
    'UPDATE users SET wallet_address = $1, updated_at = NOW() WHERE chat_id = $2 RETURNING *',
    [walletAddress, numericChatId]
  );
  return result.rows[0];
}

async function updateUserAlerts(chatId, alertsThisHour, hourWindowStart) {
  const numericChatId = typeof chatId === 'string' ? parseInt(chatId, 10) : chatId;
  const result = await pool.query(
    'UPDATE users SET alerts_this_hour = $1, hour_window_start = $2, updated_at = NOW() WHERE chat_id = $3 RETURNING *',
    [alertsThisHour, hourWindowStart, numericChatId]
  );
  return result.rows[0];
}

async function recordTradeExecuted(chatId) {
  const numericChatId = typeof chatId === 'string' ? parseInt(chatId, 10) : chatId;
  const result = await pool.query(
    'UPDATE users SET last_trade_at = NOW(), updated_at = NOW() WHERE chat_id = $1 RETURNING *',
    [numericChatId]
  );
  return result.rows[0];
}

async function getAllSubscribers() {
  const result = await pool.query('SELECT chat_id FROM users WHERE subscribed_at IS NOT NULL');
  return result.rows.map(row => row.chat_id);
}

async function deleteUser(chatId) {
  const numericChatId = typeof chatId === 'string' ? parseInt(chatId, 10) : chatId;
  await pool.query('DELETE FROM users WHERE chat_id = $1', [numericChatId]);
}

// Headline Queries
async function addHeadline(title, link, pubDate) {
  try {
    const result = await pool.query(
      'INSERT INTO seen_headlines (title, link, pub_date) VALUES ($1, $2, $3) RETURNING *',
      [title, link, pubDate]
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === '23505') {
      // Duplicate key — headline already seen
      return null;
    }
    throw err;
  }
}

async function hasHeadline(title) {
  const result = await pool.query('SELECT id FROM seen_headlines WHERE title = $1 LIMIT 1', [title]);
  return result.rows.length > 0;
}

async function getHeadlineCount() {
  const result = await pool.query('SELECT COUNT(*) as count FROM seen_headlines');
  return parseInt(result.rows[0].count, 10);
}

// Trade Queries

async function recordTrade(chatId, walletAddress, marketSlug, marketTitle, side, amountUsdc, estimatedPrice, estimatedShares, txHash = null) {
  const numericChatId = typeof chatId === 'string' ? parseInt(chatId, 10) : chatId;
  
  const result = await pool.query(
    `INSERT INTO executed_trades (chat_id, wallet_address, market_slug, market_title, side, amount_usdc, estimated_price, estimated_shares, tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [numericChatId, walletAddress, marketSlug, marketTitle, side, amountUsdc, estimatedPrice, estimatedShares, txHash]
  );
  return result.rows[0];
}

async function getTradesByWallet(walletAddress, limit = 50) {
  const result = await pool.query(
    'SELECT * FROM executed_trades WHERE wallet_address = $1 ORDER BY executed_at DESC LIMIT $2',
    [walletAddress, limit]
  );
  return result.rows;
}

async function getTradesByChatId(chatId, limit = 50) {
  const numericChatId = typeof chatId === 'string' ? parseInt(chatId, 10) : chatId;
  const result = await pool.query(
    'SELECT * FROM executed_trades WHERE chat_id = $1 ORDER BY executed_at DESC LIMIT $2',
    [numericChatId, limit]
  );
  return result.rows;
}

async function updateTradeStatus(tradeId, status, txHash = null) {
  const result = await pool.query(
    'UPDATE executed_trades SET status = $1, tx_hash = COALESCE($2, tx_hash), updated_at = NOW() WHERE id = $3 RETURNING *',
    [status, txHash, tradeId]
  );
  return result.rows[0];
}

// Export

module.exports = {
  pool,
  initializeDatabase,
  // Users
  getUser,
  getUserByWallet,
  createUser,
  updateUserWallet,
  updateUserAlerts,
  recordTradeExecuted,
  getAllSubscribers,
  deleteUser,
  // Headlines
  addHeadline,
  hasHeadline,
  getHeadlineCount,
  // Trades
  recordTrade,
  getTradesByWallet,
  getTradesByChatId,
  updateTradeStatus,
};