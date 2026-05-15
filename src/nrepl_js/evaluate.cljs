(ns nrepl-js.evaluate
  (:require [nrepl-js.format :as fmt]
            [promesa.core :as p]))

(defn- no-watch [file]
  (js/JSON.stringify (array "literal" (str "No watch points reachable for " file))))

(defn handle-eval [{:keys [msg session cdp scripts send]}]
  (let [^js msg msg
        ^js session session
        ^js cdp cdp
        code (or (.-code msg) "")
        file (.-file msg)]
    (js/console.log "EVAL\n" code)
    (if file
      (p/let [^js wp-res (.call (.-send cdp) cdp "Runtime.evaluate"
                                #js {:expression (str "globalThis.__lazuli?.watchPoints[\"" file "\"]")
                                     :returnByValue true})]
        (if (= (.. wp-res -result -type) "undefined")
          (send #js {:id (.-id msg) :session (.-id session)
                     :ex (no-watch file) :status (array "done" "error")})
          (let [watch-points (.. wp-res -result -value)]
            (let [row (loop [r (.-line msg)]
                        (cond
                          (< r 0) -1
                          (aget watch-points r) r
                          :else (recur (dec r))))]
              (if (= row -1)
                (send #js {:id (.-id msg) :session (.-id session)
                           :ex (no-watch file) :status (array "done" "error")})
                (p/let [^js watch-point (.call (.-send cdp) cdp "Runtime.evaluate"
                                               #js {:expression (str "globalThis.__lazuli?.watchPoints[\"" file "\"][" row "]")})
                        _ (js/console.log "HIT WATCH" (str "globalThis.__lazuli?.watchPoints[\"" file "\"][" row "]"))
                        ^js eval-result (.call (.-send cdp) cdp "Runtime.callFunctionOn"
                                               #js {:objectId (.. watch-point -result -objectId)
                                                    :functionDeclaration "function(text) { return this(text) }"
                                                    :arguments (array #js {:value code})})
                        parsed-result (fmt/parse-result cdp (.-result eval-result))]
                  (js/console.log "PARSED" (js/JSON.stringify #js {:result parsed-result}))
                  (send #js {:id (.-id msg)
                             :session (.-id session)
                             :value (js/JSON.stringify #js {:result parsed-result})
                             :status (array "done")})))))))
      (let [normalized-code (.replace (.replace code #"\\" "\\\\") #"\"" "\\\"")]
        (p/let [^js eval-result (.call (.-send cdp) cdp "Runtime.evaluate"
                                       #js {:expression (str "eval"
                                                             "(\"" normalized-code "\")")})
                parsed-result (fmt/parse-result cdp (.-result eval-result))
                key (if (.-exceptionDetails eval-result) :ex :value)]
          (def eval-result eval-result)
          (def parsed-result parsed-result)
          (if (.-exceptionDetails eval-result)
            (send #js {:id (.-id msg)
                       :session (.-id session)
                       :ex (js/JSON.stringify #js {:result parsed-result})
                       :status #js ["done" "error"]})
            (send #js {:id (.-id msg)
                       :session (.-id session)
                       :value (js/JSON.stringify #js {:result parsed-result})
                       :status #js ["done"]})))))))
