using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;

namespace DemoShop.Api.Controllers
{
    [ApiController]
    [Route("orders/v1")]
    public class OrdersController : ControllerBase
    {
        private readonly IOrderService _orders;

        public OrdersController(IOrderService orders)
        {
            _orders = orders;
        }

        [HttpGet("cart")]
        public async Task<IActionResult> GetCart()
        {
            var cart = await _orders.GetCart();
            return Ok(cart);
        }

        [HttpPost("cart/items")]
        public async Task<IActionResult> AddCartItem([FromBody] AddCartItemRequest request)
        {
            if (request == null || request.Quantity <= 0)
            {
                return BadRequest("quantity must be positive");
            }

            await _orders.AddItem(request.ProductId, request.Quantity);
            return Ok();
        }

        [HttpPost("checkout")]
        public async Task<IActionResult> Checkout([FromBody] CheckoutRequest request)
        {
            if (request == null || string.IsNullOrEmpty(request.PaymentToken))
            {
                return BadRequest("paymentToken is required");
            }

            var placed = await _orders.PlaceOrder(request.PaymentToken);
            if (!placed)
            {
                return Forbid();
            }

            return Ok();
        }
    }
}
