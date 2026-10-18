using System;

namespace Bakery.Api.Models
{
    public class OrderRequest
    {
        public int Loaves { get; set; }
        public int Flour { get; set; }
        public int Sugar { get; set; }
    }

    public class Order
    {
        public Order(OrderRequest request)
        {
            Loaves = request.Loaves;
            Flour = request.Flour;
            Sugar = request.Sugar;
        }

        public int Loaves { get; set; }
        public int Flour { get; set; }
        public int Sugar { get; set; }
        public string Ticket { get; set; }
        public bool Valid { get; set; } = true;
    }

    public class GrantContext
    {
        public GrantContext(string orderId)
        {
            OrderId = orderId;
        }

        public string OrderId { get; set; }
        public string Caller { get; set; }
        public bool Granted { get; set; }
    }

    public class TastingRequest
    {
        public string Taster { get; set; }
        public bool Certified { get; set; }
    }

    public class GlazeRequest
    {
        public string Flavour { get; set; }
    }

    public class Glaze
    {
        public Glaze(GlazeRequest request)
        {
            Flavour = request.Flavour;
        }

        public string Flavour { get; set; }
        public bool Valid { get; set; } = true;
    }

    public class FillOrder
    {
        public FillOrder(GlazeRequest request)
        {
            Flavour = request.Flavour;
        }

        public string Flavour { get; set; }
        public bool Valid { get; set; } = true;
    }

    public class TopOrder
    {
        public string Flavour { get; set; }
        public bool Valid { get; set; } = true;
    }

    public class OvenBusyException : Exception
    {
    }

    public class CrustCrackedException : Exception
    {
    }
}
