# Wdrożenie na Azure (krok po kroku)

Ta instrukcja uruchamia ankietę na **Azure App Service** w darmowym planie **F1**,
korzystając z **Azure for Students** z GitHub Student Developer Pack.
Po konfiguracji każda zmiana wypchnięta na domyślną gałąź repozytorium
wdraża się sama przez GitHub Actions.

Całość zajmuje około 15 minut. Wszystko robisz w przeglądarce.

---

## 1. Aktywuj Azure for Students

1. Wejdź na <https://azure.microsoft.com/free/students> i kliknij **Start free**.
2. Zaloguj się. Najlepiej użyj szkolnego adresu e-mail albo konta GitHub
   powiązanego ze Student Pack.
3. Po weryfikacji dostajesz subskrypcję **Azure for Students** ($100 kredytu na rok).
   Microsoft zwykle nie wymaga karty kredytowej.

## 2. Utwórz aplikację (Web App)

1. Otwórz <https://portal.azure.com>, a potem **Create a resource → Web App**.
2. Na karcie **Basics** wypełnij:

   | Pole | Wartość |
   | --- | --- |
   | Subscription | **Azure for Students** |
   | Resource Group | **Create new**, np. `ankieta` |
   | Name | unikalna nazwa, np. `moja-ankieta`. Stanie się adresem `https://moja-ankieta.azurewebsites.net` (Azure może dopisać do niego losowy ciąg znaków) |
   | Publish | **Code** |
   | Runtime stack | **Node 22 LTS** |
   | Operating System | **Linux** |
   | Region | np. **Poland Central** albo **West Europe** |
   | Pricing plan | **Free F1** (kliknij *Explore pricing plans*, jeśli F1 nie jest domyślnie wybrany) |

   > Jeśli Azure zgłosi, że region jest niedostępny dla Twojej subskrypcji,
   > wybierz inny region z listy.

3. Kliknij **Review + create**, a potem **Create**. Poczekaj około minuty i kliknij **Go to resource**.

## 3. Ustaw hasło admina i włącz wdrażanie

Będąc na stronie swojej aplikacji w portalu:

1. **Settings → Environment variables → App settings → + Add**
   - Name: `ADMIN_PASSWORD`
   - Value: silne hasło do panelu admina

   Kliknij **Apply**, a potem **Apply → Confirm** na dole strony.

   Nic więcej nie trzeba ustawiać. Aplikacja sama wykrywa, że działa na Azure, i wtedy:
   - trzyma bazę w `/home/data/survey.db` (ten katalog nie jest kasowany przy restartach i wdrożeniach),
   - ustawia tryb bazy odpowiedni dla dysku sieciowego,
   - wysyła ciasteczka tylko przez HTTPS.

2. **Settings → Configuration → General settings**
   - **SCM Basic Auth Publishing Credentials**: **On**. To ustawienie jest potrzebne do wdrażania z GitHuba.
   - **HTTPS Only**: **On**.
   - **Startup Command**: zostaw puste (Azure sam uruchomi `npm start`).

   Kliknij **Save**, a potem **Continue**.

3. **Overview → Download publish profile**. Pobierze się plik `.PublishSettings`.

## 4. Połącz repozytorium GitHub z Azure

W repozytorium na GitHubie otwórz **Settings → Secrets and variables → Actions**:

1. Karta **Secrets → New repository secret**
   - Name: `AZURE_WEBAPP_PUBLISH_PROFILE`
   - Secret: cała zawartość pobranego pliku `.PublishSettings` (otwórz go w Notatniku, skopiuj i wklej)
2. Karta **Variables → New repository variable**
   - Name: `AZURE_WEBAPP_NAME`
   - Value: nazwa aplikacji z kroku 2 (np. `moja-ankieta`)

## 5. Wdróż

- Otwórz kartę **Actions → Test and deploy to Azure → Run workflow**.
  Wybierz domyślną gałąź i kliknij **Run workflow**.
- Od tej pory każda zmiana wypchnięta na domyślną gałąź wdraża się automatycznie.
  Najpierw uruchamiają się testy. Jeśli któryś nie przejdzie, wdrożenie się nie wykona.

Po 1–3 minutach ankieta działa pod adresem:

- ankieta: `https://<nazwa>.azurewebsites.net/`
- panel admina: `https://<nazwa>.azurewebsites.net/admin`

Przy pierwszym uruchomieniu aplikacja sama wczytuje 50 przykładowych pytań.

## 6. Przekierowanie ze starej strony GitHub Pages (opcjonalnie)

W repozytorium, z którego działa Twoja obecna strona GitHub Pages, zastąp zawartość
pliku `index.html` poniższym kodem. Wstaw w nim adres swojej aplikacji:

```html
<!doctype html>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=https://moja-ankieta.azurewebsites.net/">
<link rel="canonical" href="https://moja-ankieta.azurewebsites.net/">
<title>Ankieta</title>
<p>Przekierowuję do <a href="https://moja-ankieta.azurewebsites.net/">ankiety</a>…</p>
```

---

## Dobrze wiedzieć

- **Limity planu F1:** około 60 minut pracy procesora dziennie. Jedna odpowiedź to ułamek sekundy,
  więc na ankietę w zupełności wystarczy.
- **Usypianie:** na F1 aplikacja zasypia po około 20 minutach bez ruchu. Pierwsze wejście
  po przerwie trwa wtedy kilka sekund dłużej. Dane nie giną.
- **Większy ruch:** jeśli ankieta ma trafić do wielu osób naraz, możesz w
  **Settings → Scale up** przełączyć plan na **B1** (około $13 miesięcznie z kredytu studenckiego).
  Nic w aplikacji nie trzeba wtedy zmieniać.
- **Kopia zapasowa:** najprościej pobrać dane przez **Export .xlsx** w panelu admina.
  Pełną kopię bazy (`/home/data/survey.db`) pobierzesz przez **Development Tools → Advanced Tools → Go**
  (Kudu), w sekcji plików.
- **Logi:** **Monitoring → Log stream** pokazuje na żywo, co wypisuje aplikacja.
  Przy starcie zobaczysz tam na przykład `Database: /home/data/survey.db (journal mode DELETE)`.
- **Zmiana hasła admina:** zmień `ADMIN_PASSWORD` w **Environment variables**.
  Aplikacja zrestartuje się sama.

## Gdy coś nie działa

| Objaw | Co sprawdzić |
| --- | --- |
| Wdrożenie w Actions kończy się błędem `401` / `Unauthorized` | Czy **SCM Basic Auth Publishing Credentials** jest włączone? Pobierz publish profile jeszcze raz i podmień sekret. |
| Zadanie *deploy* w Actions jest pomijane (*skipped*) | Brakuje zmiennej `AZURE_WEBAPP_NAME` albo uruchamiasz workflow na gałęzi innej niż domyślna. |
| Strona pokazuje *Application Error* | Otwórz **Log stream**. Najczęstsza przyczyna to brak `ADMIN_PASSWORD` (w logach: *Please set the ADMIN_PASSWORD…*). |
| Błąd o `node:sqlite` | W **Configuration → General settings** ustaw **Node 22 LTS**. Aplikacja wymaga Node 22.5 lub nowszego. |
