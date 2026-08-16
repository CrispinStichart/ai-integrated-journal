<template>
  <section aria-labelledby="today-title">
    <p class="mb-2 text-sm font-medium text-base-content/60">Your journal</p>
    <h1 id="today-title" class="text-3xl font-bold tracking-tight sm:text-4xl">
      Today
    </h1>
    <p class="mt-3 max-w-2xl text-base-content/70">
      This shell is ready for durable text and audio capture workflows. Journal
      content and AI processing will remain independent.
    </p>
    <div class="mt-8 grid gap-4 sm:grid-cols-2">
      <article class="card card-border bg-base-100">
        <div class="card-body">
          <h2 class="card-title">Capture</h2>
          <p>
            Text and audio capture will be available here, including while the
            network is unavailable.
          </p>
          <div class="card-actions justify-end">
            <button class="btn" type="button" disabled>
              Coming in the next phase
            </button>
          </div>
        </div>
      </article>
      <article class="card card-border bg-base-100">
        <div class="card-body">
          <h2 class="card-title">Today’s timeline</h2>
          <p>
            Contributions will remain separate while appearing together in a
            coherent day view.
          </p>
        </div>
      </article>
    </div>
  </section>
</template>
