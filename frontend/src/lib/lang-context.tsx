"use client";

import { createContext, useContext, useState, useEffect } from "react";

export type Lang = "en" | "ar";

interface LangContextType {
  lang: Lang;
  setLang: (l: Lang) => void;
}

const LangContext = createContext<LangContextType>({ lang: "ar", setLang: () => {} });

export function LangProvider({ children }: { children: React.ReactNode }) {
  // Arabic by default. Every visitor arrives from an Arabic landing page and an
  // Arabic ad, and the default was sending them to an English "Welcome back"
  // form. Anyone who has chosen a language still gets it -- the stored
  // preference is read below and wins.
  const [lang, setLangState] = useState<Lang>("ar");

  useEffect(() => {
    const saved = localStorage.getItem("ui_lang");
    if (saved === "ar" || saved === "en") setLangState(saved);
  }, []);

  useEffect(() => {
    document.documentElement.dir  = lang === "ar" ? "rtl" : "ltr";
    document.documentElement.lang = lang;
  }, [lang]);

  function setLang(l: Lang) {
    setLangState(l);
    localStorage.setItem("ui_lang", l);
  }

  return <LangContext.Provider value={{ lang, setLang }}>{children}</LangContext.Provider>;
}

export function useLang() {
  return useContext(LangContext);
}
