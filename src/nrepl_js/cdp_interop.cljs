(ns nrepl-js.cdp-interop
  (:require [promesa.core :as p]))

(defn ^:async call
  ([^js cdp method] (.send cdp method))
  ([^js cdp method params]
   (let [res (await (.send cdp method (clj->js params)))]
     (js->clj res :keywordize-keys true))))

(defn on
  [^js cdp event handler]
  (.on cdp event (fn [params] (handler (js->clj params :keywordize-keys true)))))
