import { Link, Outlet, useLocation } from 'react-router';
import {
  BarChart3,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  History,
  Play,
  RefreshCw,
  SlidersHorizontal,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppShell } from '@/app/app-context';
import { cn } from '@/lib/utils';

function shiftIsoDate(value: string, days: number): string {
  const parts = value.split('-').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
    return value;
  }
  const [year, month, day] = parts as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const navItems = [
  { to: '/', label: '今日推荐', icon: BarChart3, active: (path: string) => path === '/' },
  {
    to: '/strategies',
    label: '策略',
    icon: SlidersHorizontal,
    active: (path: string) => path.startsWith('/strategies'),
  },
  {
    to: '/history',
    label: '历史',
    icon: History,
    active: (path: string) => path.startsWith('/history'),
  },
] as const;

export default function App() {
  const location = useLocation();
  const ctx = useAppShell();
  const shiftGlobalDate = (days: number) => ctx.setGlobalDate(shiftIsoDate(ctx.globalDate, days));

  return (
    <div className="app-shell">
      <header className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 border-b border-border/70 bg-white/90 px-2.5 py-3 backdrop-blur md:px-4 md:py-1.5">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 md:gap-3 w-full md:w-auto">
          <div className="flex items-center gap-1.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-[var(--shadow-control)]">
              <BarChart3 className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0 select-none">
              <div className="font-bold text-xs leading-4 tracking-normal text-foreground">
                QUANT CORE
              </div>
              <div className="hidden text-[10px] leading-3 text-muted-foreground sm:block">
                可解释推荐
              </div>
            </div>
          </div>
          <span className="hidden md:inline text-muted-foreground/30 text-[10px]">|</span>
          <nav className="flex flex-wrap items-center gap-1 sm:gap-0.5">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = item.active(location.pathname);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  data-active={active}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'app-nav-link inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold text-muted-foreground hover:bg-white hover:text-foreground hover:shadow-[var(--shadow-control)] whitespace-nowrap',
                    active && 'bg-white text-foreground shadow-[var(--shadow-control)]'
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-1.5 border-t border-border/40 pt-2.5 md:w-auto md:justify-end md:gap-2 md:border-t-0 md:pt-0">
          <div className="flex w-full min-w-0 items-center gap-1 sm:w-auto sm:flex-none">
            <Button
              variant="outline"
              size="icon"
              className="h-7.5 w-7.5 shrink-0"
              onClick={() => shiftGlobalDate(-1)}
              title="前一天"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Input
              type="date"
              className="number-figure h-7.5 min-w-[150px] flex-1 px-2 py-0.5 text-xs md:w-[150px] md:flex-none"
              value={ctx.globalDate}
              onClick={(event) => event.currentTarget.showPicker?.()}
              onChange={(event) => ctx.setGlobalDate(event.target.value)}
            />
            <Button
              variant="outline"
              size="icon"
              className="h-7.5 w-7.5 shrink-0"
              onClick={() => shiftGlobalDate(1)}
              title="后一天"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="min-w-[136px] flex-1 md:flex-none">
            <Select value={ctx.activeStrategyId} onValueChange={ctx.setActiveStrategyId}>
              <SelectTrigger className="w-full md:w-[135px] h-7.5 text-xs">
                <SelectValue placeholder="全部策略" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">
                  全部策略
                </SelectItem>
                {ctx.strategies.map((strategy) => (
                  <SelectItem key={strategy.id} value={strategy.id} className="text-xs">
                    {strategy.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            size="icon"
            className="h-7.5 w-7.5 shrink-0"
            onClick={() => void ctx.refreshStrategies()}
            title="刷新策略"
          >
            <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
          <div className="hidden items-center gap-1 rounded-md border border-border/60 bg-white/80 px-2 py-1 text-[11px] text-muted-foreground shadow-[var(--shadow-control)] xl:flex">
            <CalendarDays className="h-3.5 w-3.5 text-sky-600" />
            <span className="number-figure">{ctx.globalDate}</span>
          </div>
          <Button
            size="sm"
            className="h-7.5 text-xs gap-1.5 shrink-0 px-3 shadow-[var(--shadow-control)]"
            onClick={() => void ctx.runGlobalAnalysis()}
          >
            <Play className="h-3 w-3 fill-current" />
            分析推演
          </Button>
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
