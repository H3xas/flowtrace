describe('stock reservations', () => {
  it('reserves stock from the product page', () => {
    cy.intercept('POST', '**/stock/v1/reservations', { statusCode: 202 }).as('reserve');
    cy.visit('/products/umbrella');
    cy.contains('Reserve').click();
    cy.wait('@reserve');
  });
});
