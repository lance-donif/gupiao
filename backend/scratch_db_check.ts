import pg from 'pg';

const pool = new pg.Pool({
  connectionString: 'postgresql://gupiao:password@localhost:5432/gupiaodb'
});

async function main() {
  const client = await pool.connect();
  try {
    const query = [
      'SELECT s."symbol", MAX(c."tradingDay") AS "latestTradeDay"',
      'FROM "Stock" s',
      'LEFT JOIN "Candle" c ON c."stockId" = s.id',
      'WHERE s."clusterKey" = $1',
      'GROUP BY s."symbol"',
    ].join(' ');
    
    const result = await client.query<{ symbol: string; latestTradeDay: Date | string }>(query, ['global']);
    
    console.log(`SQL 返回总行数: ${result.rowCount}`);
    if (result.rowCount && result.rowCount > 0) {
      console.log(`前 5 条原始记录:`);
      for (const row of result.rows.slice(0, 5)) {
        console.log(`  symbol: ${row.symbol}, latestTradeDay: ${row.latestTradeDay} (类型: ${typeof row.latestTradeDay})`);
      }
      
      const map = new Map<string, string>();
      for (const row of result.rows) {
        if (row.latestTradeDay) {
          const date = new Date(row.latestTradeDay);
          const yyyy = date.getUTCFullYear();
          const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
          const dd = String(date.getUTCDate()).padStart(2, '0');
          map.set(row.symbol, `${yyyy}-${mm}-${dd}`);
        }
      }
      console.log(`Map 填充后的总键数: ${map.size}`);
      if (map.size > 0) {
        console.log(`Map 样例: 000050 => ${map.get('000050')}`);
      }
    }
  } catch (err) {
    console.error('SQL 调试失败:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
