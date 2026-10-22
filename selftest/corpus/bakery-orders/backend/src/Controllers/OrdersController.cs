using System.Threading.Tasks;
using Bakery.Api.Models;
using Bakery.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace Bakery.Api.Controllers
{
    [ApiController]
    [Route("bakery/v1/orders")]
    public class OrdersController : ControllerBase
    {
        private readonly IOrderService _orders;

        public OrdersController(IOrderService orders)
        {
            _orders = orders;
        }

        [HttpPost]
        public async Task<IActionResult> Place([FromBody] OrderRequest request)
        {
            try
            {
                var placed = await _orders.PlaceAsync(request);
                return placed is not null ? Ok(placed) : BadRequest();
            }
            catch (OvenBusyException)
            {
                return Conflict();
            }
        }

        [HttpPost("draft")]
        public async Task<IActionResult> Draft([FromBody] OrderRequest request)
        {
            try
            {
                var placed = await _orders.DraftAsync(request);
                return placed is not null ? Ok(placed) : BadRequest();
            }
            catch (OvenBusyException)
            {
                return Conflict();
            }
        }

        [HttpPost("precheck")]
        public async Task<IActionResult> Precheck([FromBody] OrderRequest request)
        {
            var checkedOrder = await _orders.PrecheckAsync(request);
            return checkedOrder is not null ? Ok(checkedOrder) : BadRequest();
        }

        [HttpPost("check")]
        public IActionResult Check([FromBody] OrderRequest request)
        {
            var passes = _orders.Check(request);
            return passes ? Ok(true) : BadRequest();
        }

        [HttpDelete("{id}")]
        public async Task<IActionResult> Cancel(string id)
        {
            var allowed = await _orders.CancelAsync(id);
            return allowed ? NoContent() : Forbid();
        }

        [HttpPost("layers")]
        public async Task<IActionResult> Layer([FromBody] OrderRequest request)
        {
            var layered = await _orders.LayerAsync(request);
            return layered is not null ? Ok(layered) : BadRequest();
        }
    }
}
