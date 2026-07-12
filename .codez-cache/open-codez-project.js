(async () => {
  const name = Array.from(document.querySelectorAll('.homepage-project-name'))
    .find((element) => element.textContent?.trim() === 'CodeZ')
  name?.closest('.homepage-project-item')?.click()
  await new Promise((resolve) => setTimeout(resolve, 800))
  return Boolean(name)
})()
