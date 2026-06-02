async function run() {
  const { default: YahooFinance } = await import('yahoo-finance2');
  // Need to handle type casting as in the actual code
  const client = (YahooFinance as any).default || YahooFinance; 
  // Wait, the error said Call `new YahooFinance()`.
  const instance = new client({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });
  
  try {
    const res = await instance.chart('000001.SZ', { period1: '2026-05-25', period2: '2026-05-25', interval: '1d' });
    console.log('25-25:', res.quotes ? res.quotes.length : 0);
  } catch (e) {
    console.log('25-25 error:', e.message);
  }
  try {
    const res = await instance.chart('000001.SZ', { period1: '2026-05-25', period2: '2026-05-26', interval: '1d' });
    console.log('25-26:', res.quotes ? res.quotes.length : 0);
  } catch (e) {
    console.log('25-26 error:', e.message);
  }
}
run();
