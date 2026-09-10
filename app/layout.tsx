import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import './globals.css'
import Script from "next/script";

export const metadata: Metadata = {
  title: 'JF Radar Meteorológico | Monitoramento Regional | AO VIVO e Previsão',
  description: 'Radar meteorológico regional em tempo real para Juiz de Fora e Zona da Mata.',
  generator: '@enricomalta',
  icons: {
    icon: [
      {
        url: '/icon.svg',
      },
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
    ],
    apple: '/apple-icon.png',
  },
}

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: 'white' },
    { media: '(prefers-color-scheme: dark)', color: 'black' },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="pt-BR" className="bg-[#071016]">
      <body className="antialiased">
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
      <Script id="credits" strategy="afterInteractive">
        {`
          console.log("Desenvolvido por: https://www.linkedin.com/in/enrico-malta1/");
          console.log("Todos os direitos reservados!");
          console.log("Utilizado dados publicos do SISURB Juiz de Fora para demarcação dos bairros");
          console.log("Previsão obtemos do Tomorrow.io");
          console.log("Radar AO Vivo obtemos do Rainviewer.com");
        `}
      </Script>

    </html>
  )
}
