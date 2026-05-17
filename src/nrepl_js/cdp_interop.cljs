(ns nrepl-js.cdp-interop)

(defn call [^js conn method params]
  (.call (.-send conn) conn method (clj->js (or params {}))))

(defn on [^js conn event listener]
  (.call (.-on conn) conn event listener))
