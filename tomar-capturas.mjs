import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function tomarCapturas() {
  const browser = await puppeteer.launch({
    executablePath: '/usr/local/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  try {
    console.log('Navegando a la aplicación...');
    await page.goto('http://localhost:3005', { waitUntil: 'networkidle2' });
    
    // Captura del login
    console.log('Captura 1: Pantalla de login');
    await page.screenshot({ path: 'captura-1-login.png', fullPage: false });
    
    // Hacer login
    console.log('Iniciando sesión...');
    await page.type('input[type="email"]', 'juan@finanzas.cl');
    await page.type('input[type="password"]', 'demo123');
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Captura del dashboard
    console.log('Captura 2: Panel principal');
    await page.screenshot({ path: 'captura-2-dashboard.png', fullPage: true });
    
    // Navegar a cuentas
    console.log('Navegando a cuentas...');
    await page.click('a[href="/cuentas"]');
    await new Promise(resolve => setTimeout(resolve, 1000));
    console.log('Captura 3: Cuentas');
    await page.screenshot({ path: 'captura-3-cuentas.png', fullPage: true });
    
    // Navegar a importar
    console.log('Navegando a importar...');
    await page.click('a[href="/importar"]');
    await new Promise(resolve => setTimeout(resolve, 1000));
    console.log('Captura 4: Importar');
    await page.screenshot({ path: 'captura-4-importar.png', fullPage: true });
    
    console.log('✓ Capturas completadas');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await browser.close();
  }
}

tomarCapturas();
