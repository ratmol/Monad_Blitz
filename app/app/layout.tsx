import type {Metadata} from "next";
import {Big_Shoulders, Geist, IBM_Plex_Mono} from "next/font/google";
import "./globals.css";

/**
 * Geist for prose, IBM Plex Mono for anything a human might compare digit by digit,
 * Big Shoulders Display for the handful of headlines that need to be shouted rather
 * than read. That third face only ever appears at hero scale — an engineering-signage
 * condensed cut, not a sports-branding cliche, so it reads as "pit wall placard" and
 * not "team jersey".
 */
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  weight: ["400", "500", "600"],
  subsets: ["latin"],
});

const bigShoulders = Big_Shoulders({
  variable: "--font-big-shoulders",
  weight: ["600", "700", "800"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "LEASH — an agent on a leash",
  description:
    "An untrusted AI agent rebalances a vault on Monad under on-chain constraints it cannot break.",
};

export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${plexMono.variable} ${bigShoulders.variable} snap-shell h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <div className="ambient-grid" aria-hidden />
        <div className="relative z-10 flex min-h-full flex-col">{children}</div>
      </body>
    </html>
  );
}
