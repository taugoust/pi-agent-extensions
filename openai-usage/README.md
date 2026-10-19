# OpenAI usage status

`/usage` reports only the locally effective OpenAI credential binding and provides the official settings page. It does not query usage endpoints or claim that an API key or ChatGPT grant has remote quota/entitlement. API keys are labeled configured, not validated. No numerical quota placeholders are shown.

Enable `programs.pi.extensions.usage.enable` in the pi-agent-extensions Home Manager module. `pi-accounts` publishes the safe session status service; without it, `/usage` still links to OpenAI's platform usage settings.
