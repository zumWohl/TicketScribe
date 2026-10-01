import type { TicketScribeApi } from './index';

declare global {
  interface Window {
    ticketScribe: TicketScribeApi;
  }
}
