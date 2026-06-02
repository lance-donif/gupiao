import sqlite3
import time
import baostock as bs
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
# 脚本已经过时，仅仅用来参考下载数据写法。
# ================= 配置区 =================
START_DATE = "2024-06-01"
END_DATE = "2026-02-27"
DB_PATH = Path("./stock_data.db")
CONCURRENCY = 6  # 建议保持 5-8，避免触发 Baostock 连接数限制
REQUEST_INTERVAL = 0.01  # 请求间隔
# ==========================================

def init_sqlite_db():
    """初始化数据库，优化主键顺序提升插入性能"""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # 调整主键为 (code, date)，更契合按股票下载的聚簇索引写入
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS daily_data (
            date TEXT,
            code TEXT,
            open REAL,
            close REAL,
            high REAL,
            low REAL,
            volume REAL,
            amount REAL,
            turn REAL,
            pctChg REAL,
            isST INTEGER,
            PRIMARY KEY (code, date) 
        )
    ''')
    
    # 建立日期索引，大幅加速你后续按天查询 (如 pandas read_sql) 的速度
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_date ON daily_data (date)')
    conn.commit()
    return conn

def get_downloaded_stocks(conn) -> set:
    """获取已经完成下载的股票代码列表（断点续传核心）"""
    cursor = conn.cursor()
    cursor.execute('SELECT DISTINCT code FROM daily_data')
    return {row[0] for row in cursor.fetchall()}

def get_stock_universe() -> list:
    """获取最新交易日的全市场股票代码池"""
    bs.login()
    
    # 1. 寻找给定范围内的最后一个有效交易日
    rs_days = bs.query_trade_dates(start_date=START_DATE, end_date=END_DATE)
    last_trading_day = END_DATE
    while (rs_days.error_code == '0') and rs_days.next():
        row = rs_days.get_row_data()
        if row[1] == '1':
            last_trading_day = row[0]
            
    # 2. 获取该交易日的全市场代码
    rs_list = bs.query_all_stock(day=last_trading_day)
    stocks =[]
    while (rs_list.error_code == '0') and rs_list.next():
        code = rs_list.get_row_data()[0]
        # 仅保留A股股票，过滤掉指数(sh.000, sz.399等)，因为指数不支持 isST 字段会报错
        if code.startswith('sh.6') or code.startswith('sz.0') or code.startswith('sz.3') or code.startswith('bj'):
            stocks.append(code)
            
    bs.logout()
    return stocks

def download_stock_worker(code):
    """
    进程池工作函数：【1次请求】获取该股票在整个时间段的全部历史数据
    """
    start_time = time.time()
    bs.login()
    
    results =[]
    try:
        time.sleep(REQUEST_INTERVAL)
        fields = "date,code,open,close,high,low,volume,amount,turn,pctChg,isST"
        
        # 核心优化：直接请求整个日期范围
        rs = bs.query_history_k_data_plus(
            code, fields,
            start_date=START_DATE, end_date=END_DATE,
            frequency="d", adjustflag="3" # 3为后复权
        )
        
        def safe_float(val): return float(val) if val else None
        def safe_int(val): return int(val) if val else None
        
        while (rs.error_code == '0') and rs.next():
            row = rs.get_row_data()
            parsed_row = (
                row[0],               # date
                row[1],               # code
                safe_float(row[2]),   # open
                safe_float(row[3]),   # close
                safe_float(row[4]),   # high
                safe_float(row[5]),   # low
                safe_float(row[6]),   # volume
                safe_float(row[7]),   # amount
                safe_float(row[8]),   # turn
                safe_float(row[9]),   # pctChg
                safe_int(row[10])     # isST
            )
            results.append(parsed_row)
            
    finally:
        bs.logout()
        
    duration = time.time() - start_time
    return code, results, duration

def main():
    total_start_time = time.time()
    
    print(">>> 正在初始化数据库并核对历史数据...")
    conn = init_sqlite_db()
    downloaded_stocks = get_downloaded_stocks(conn)
    
    print(">>> 正在获取 A 股全市场股票池...")
    all_stocks = get_stock_universe()
    
    # 断点续传：剔除数据库中已经存在的股票
    pending_stocks =[s for s in all_stocks if s not in downloaded_stocks]
    
    print(f"全市场 A 股总计: {len(all_stocks)} 只")
    print(f"已入库完成股票: {len(downloaded_stocks)} 只")
    print(f"本次待下载股票: {len(pending_stocks)} 只\n" + "-"*40)
    
    if not pending_stocks:
        print("所有数据均已下载完毕！")
        return
        
    total_inserted = 0
    
    with ProcessPoolExecutor(max_workers=CONCURRENCY) as executor:
        future_to_stock = {executor.submit(download_stock_worker, code): code for code in pending_stocks}
        
        for future in as_completed(future_to_stock):
            code = future_to_stock[future]
            try:
                _, records, duration = future.result()
                
                if records:
                    # 单线程极速批量写入 SQLite
                    cursor = conn.cursor()
                    cursor.executemany('''
                        INSERT OR REPLACE INTO daily_data 
                        (date, code, open, close, high, low, volume, amount, turn, pctChg, isST)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ''', records)
                    conn.commit()
                    
                total_inserted += len(records)
                print(f"[下载完成] {code}: 获取 {len(records)} 天数据, 耗时 {duration:.2f}s")
                
            except Exception as e:
                print(f"[错误] 处理股票 {code} 时发生异常: {e}")

    conn.close()
    
    print("\n" + "="*40)
    print("✅ 任务完美结束汇总：")
    print(f"总计新下载股票：{len(pending_stocks)} 只")
    print(f"总计入库K线条数：{total_inserted} 条")
    print(f"总耗时：{int(time.time() - total_start_time)}s")
    print("="*40)

if __name__ == "__main__":
    main()