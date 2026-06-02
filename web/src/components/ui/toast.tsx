import * as React from 'react';
import { Toast as ToastPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export interface ToastMessage {
  id: string;
  title: string;
  description?: string;
  variant?: 'default' | 'destructive';
}

interface ToastContextValue {
  toast: (message: Omit<ToastMessage, 'id'>) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = React.useState<ToastMessage[]>([]);
  const toast = React.useCallback((message: Omit<ToastMessage, 'id'>) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setMessages(current => [{ ...message, id }, ...current].slice(0, 4));
    window.setTimeout(() => {
      setMessages(current => current.filter(item => item.id !== id));
    }, 4200);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      <ToastPrimitive.Provider swipeDirection="right">
        {children}
        {messages.map(message => (
          <ToastPrimitive.Root
            key={message.id}
            open
            className={cn(
              'grid gap-1 rounded-lg border border-border bg-background p-4 text-sm shadow-lg',
              message.variant === 'destructive' && 'border-destructive text-destructive',
            )}
          >
            <ToastPrimitive.Title className="font-semibold">{message.title}</ToastPrimitive.Title>
            {message.description && (
              <ToastPrimitive.Description className="text-muted-foreground">
                {message.description}
              </ToastPrimitive.Description>
            )}
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="fixed right-4 top-4 z-[100] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error('ToastProvider is missing');
  }
  return context;
}
