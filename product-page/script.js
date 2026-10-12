// Gallery thumbnails
document.querySelectorAll('.product-gallery__thumb').forEach((thumb) => {
  thumb.addEventListener('click', () => {
    document.querySelectorAll('.product-gallery__thumb').forEach((t) =>
      t.classList.remove('product-gallery__thumb--active')
    );
    thumb.classList.add('product-gallery__thumb--active');

    const mainImage = document.querySelector('.product-gallery__main-image');
    const thumbImage = thumb.querySelector('img');
    if (mainImage && thumbImage) {
      mainImage.src = thumbImage.src.replace('150x150', '800x800');
    }
  });
});

// Tabs
document.querySelectorAll('.product-tabs__tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.product-tabs__tab').forEach((t) =>
      t.classList.remove('product-tabs__tab--active')
    );
    document.querySelectorAll('.product-tabs__panel').forEach((p) =>
      p.classList.remove('product-tabs__panel--active')
    );

    tab.classList.add('product-tabs__tab--active');
    document
      .getElementById(`tab-${tab.dataset.tab}`)
      .classList.add('product-tabs__panel--active');
  });
});

// Accordion
document.querySelectorAll('.accordion__header').forEach((header) => {
  header.addEventListener('click', () => {
    header.parentElement.classList.toggle('accordion__item--open');
  });
});
