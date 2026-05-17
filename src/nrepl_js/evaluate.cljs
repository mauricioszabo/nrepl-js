(ns nrepl-js.evaluate
  (:require [nrepl-js.format :as fmt]
            [promesa.core :as p]
            [nrepl-js.cdp-interop :as cdp]))

(defn- watch-point-expression
  ([file] (str "globalThis.__lazuli?.watchPoints[" (js/JSON.stringify file) "]"))
  ([file row] (str (watch-point-expression file) "[" row "]")))

(defn- result-json [parsed-result]
  (js/JSON.stringify #js {:result parsed-result}))

(defn- no-watch [file]
  (js/JSON.stringify (array "literal" (str "No watch points reachable for " file))))

(defn- send-result! [send msg session field parsed-result status]
  (send (assoc {:id (:id msg)
                :session (:id session)
                :status status}
               field
               (result-json parsed-result))))

(defn- send-no-watch! [send msg session file]
  (send {:id (:id msg)
         :session (:id session)
         :ex (no-watch file)
         :status ["done" "error"]}))

(defn- runtime-evaluate [cdp expression]
  (cdp/call cdp "Runtime.evaluate" {:expression expression}))

(defn- ^:async watch-points-for-file [cdp file]
  (let [result (await (.send cdp "Runtime.evaluate"
                             #js {:expression (watch-point-expression file)
                                  :returnByValue true}))
        result (.-result result)]
    (when-not (= "undefined" (.-type result))
      (mapv int (js/Object.keys (.-value result))))))

(defn- find-watch-row [watch-points line]
  (->> ##Inf
       (conj watch-points)
       (partition 2 1)
       (some (fn [[f l]] (and (<= f line l) f)))))

(defn- call-watch-point [cdp ^js watch-point code]
  (cdp/call cdp "Runtime.callFunctionOn"
            {:objectId (-> watch-point :result :objectId)
             :functionDeclaration "function(text) { return this(text) }"
             :arguments [{:value code}]}))

(defn- parse-eval-result [cdp ^js eval-result]
  (fmt/parse-result cdp (:result eval-result)))

(defn ^:async handle-eval [{:keys [msg session cdp send] :as request}]
  (let [code (or (:code msg) "")]
    (if-let [file (:file msg)]
      (let [watch-points-result (await (watch-points-for-file cdp file))]
        (def watch-points-result watch-points-result)

        (if watch-points-result
          (if-let [row (find-watch-row watch-points-result (:line msg))]
            (p/let [watch-point (runtime-evaluate cdp (watch-point-expression file row))
                    eval-result (call-watch-point cdp watch-point code)
                    parsed-result (parse-eval-result cdp eval-result)]
              (send-result! send msg session :value parsed-result ["done"]))
            (send-no-watch! send msg session file))
          (send-no-watch! send msg session file)))
      (p/let [eval-result (runtime-evaluate cdp (str "eval(" (js/JSON.stringify code) ")"))
              parsed-result (parse-eval-result cdp eval-result)]
        (if (:exceptionDetails eval-result)
          (send-result! send msg session :ex parsed-result ["done" "error"])
          (send-result! send msg session :value parsed-result ["done"]))))))
