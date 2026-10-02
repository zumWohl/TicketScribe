import type { CardonetCaptureApi } from './index';

declare global {
  interface Window {
    cardonetCapture: CardonetCaptureApi;
  }
}
