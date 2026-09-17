using System.Threading.Tasks;
using DemoShop.Stock.Services;
using Microsoft.AspNetCore.Mvc;

namespace DemoShop.Stock.Controllers
{
    [ApiController]
    [Route("stock/v1")]
    public class ReservationsController : ControllerBase
    {
        private readonly IReservationService _reservations;

        public ReservationsController(IReservationService reservations)
        {
            _reservations = reservations;
        }

        [HttpPost("reservations")]
        public async Task<IActionResult> Reserve([FromBody] ReserveRequest request)
        {
            if (request == null || string.IsNullOrEmpty(request.ProductId))
            {
                return BadRequest("productId is required");
            }

            var reserved = await _reservations.Reserve(request.ProductId, request.Quantity);
            if (!reserved)
            {
                return Conflict();
            }

            return Accepted();
        }
    }

    public class ReserveRequest
    {
        public string ProductId { get; set; }
        public int Quantity { get; set; }
    }
}
